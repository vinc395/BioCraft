//! Copy puts the selection on the system clipboard as a picture, so it pastes into PowerPoint, Word,
//! Teams and other programs with a transparent background. On Windows the app writes the formats
//! itself: "PNG", which Office reads first, keeps transparency and the resolution, so the picture
//! pastes at the size it had in BioCraft. CF_DIBV5 serves programs that only read bitmaps. Elsewhere
//! the page copies the PNG through the browser's Clipboard API (ui/js/clipimage.js).

use anyhow::Result;
use std::sync::atomic::{AtomicU32, Ordering};

/// The clipboard's sequence number right after BioCraft last copied a picture to it (Windows).
static OURS: AtomicU32 = AtomicU32::new(0);

/// A 32-bit bottom-up DIBV5 (BITMAPV5HEADER, then BGRA rows) of straight RGBA pixels, with the
/// resolution, and colours marked sRGB.
pub fn dibv5(rgba: &[u8], w: u32, h: u32, dpi: f32) -> Vec<u8> {
    let ppm = (dpi / 0.0254).round() as i32;
    let mut out = Vec::with_capacity(124 + rgba.len());
    let dword = |out: &mut Vec<u8>, v: u32| out.extend_from_slice(&v.to_le_bytes());
    dword(&mut out, 124); // bV5Size
    out.extend_from_slice(&(w as i32).to_le_bytes()); // bV5Width
    out.extend_from_slice(&(h as i32).to_le_bytes()); // bV5Height (positive: bottom-up)
    out.extend_from_slice(&1u16.to_le_bytes()); // bV5Planes
    out.extend_from_slice(&32u16.to_le_bytes()); // bV5BitCount
    dword(&mut out, 3); // bV5Compression: BI_BITFIELDS
    dword(&mut out, w * h * 4); // bV5SizeImage
    out.extend_from_slice(&ppm.to_le_bytes()); // bV5XPelsPerMeter
    out.extend_from_slice(&ppm.to_le_bytes()); // bV5YPelsPerMeter
    dword(&mut out, 0); // bV5ClrUsed
    dword(&mut out, 0); // bV5ClrImportant
    dword(&mut out, 0x00FF_0000); // bV5RedMask
    dword(&mut out, 0x0000_FF00); // bV5GreenMask
    dword(&mut out, 0x0000_00FF); // bV5BlueMask
    dword(&mut out, 0xFF00_0000); // bV5AlphaMask
    dword(&mut out, 0x7352_4742); // bV5CSType: LCS_sRGB
    out.extend_from_slice(&[0u8; 36]); // bV5Endpoints
    for _ in 0..3 {
        dword(&mut out, 0); // bV5GammaRed, Green, Blue
    }
    dword(&mut out, 4); // bV5Intent: LCS_GM_IMAGES
    for _ in 0..3 {
        dword(&mut out, 0); // bV5ProfileData, bV5ProfileSize, bV5Reserved
    }
    debug_assert_eq!(out.len(), 124);
    let row = w as usize * 4;
    for y in (0..h as usize).rev() {
        for px in rgba[y * row..(y + 1) * row].chunks_exact(4) {
            out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
    }
    out
}

/// Put the picture on the clipboard in place of what was there: `png` as "PNG", `dib` as CF_DIBV5.
#[cfg(windows)]
pub fn write(png: &[u8], dib: &[u8]) -> Result<()> {
    use anyhow::bail;
    use std::ffi::c_void;
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    const CF_DIBV5: u32 = 17;

    /// Movable global memory holding `bytes`; the clipboard owns it once SetClipboardData succeeds.
    unsafe fn global(bytes: &[u8]) -> Result<*mut c_void> {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if h.is_null() {
            bail!("not enough memory for the picture");
        }
        let p = GlobalLock(h) as *mut u8;
        if p.is_null() {
            GlobalFree(h);
            bail!("not enough memory for the picture");
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        GlobalUnlock(h);
        Ok(h)
    }
    unsafe fn set(format: u32, bytes: &[u8]) -> Result<()> {
        let h = global(bytes)?;
        if SetClipboardData(format, h).is_null() {
            GlobalFree(h);
            bail!("the clipboard refused the picture");
        }
        Ok(())
    }

    let name: Vec<u16> = "PNG".encode_utf16().chain(Some(0)).collect();
    let png_format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
    // another program may hold the clipboard open for a moment
    let mut open = false;
    for _ in 0..20 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            open = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    if !open {
        bail!("the clipboard is busy in another program; try again");
    }
    let res = unsafe {
        EmptyClipboard();
        // the PNG first: Office takes the first picture format it knows
        set(png_format, png).and_then(|_| set(CF_DIBV5, dib))
    };
    unsafe { CloseClipboard() };
    res?;
    OURS.store(unsafe { GetClipboardSequenceNumber() }, Ordering::Relaxed);
    Ok(())
}

#[cfg(not(windows))]
pub fn write(_png: &[u8], _dib: &[u8]) -> Result<()> {
    anyhow::bail!("on this system the page copies the picture")
}

/// Whether the clipboard still holds the picture BioCraft copied last: pasting in BioCraft then
/// pastes the copied objects themselves, not a picture of them.
pub fn is_ours() -> bool {
    #[cfg(windows)]
    {
        let ours = OURS.load(Ordering::Relaxed);
        ours != 0 && ours == unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
    }
    #[cfg(not(windows))]
    {
        let _ = &OURS;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dibv5_is_a_bottom_up_bgra_bitmap_with_alpha_and_resolution() {
        // 2×2: red, transparent / green half-transparent, blue
        let rgba = [255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255];
        let d = dibv5(&rgba, 2, 2, 300.0);
        assert_eq!(d.len(), 124 + 16);
        let le = |i: usize| u32::from_le_bytes(d[i..i + 4].try_into().unwrap());
        assert_eq!((le(0), le(4), le(8)), (124, 2, 2));
        assert_eq!(u16::from_le_bytes([d[14], d[15]]), 32);
        assert_eq!((le(16), le(20)), (3, 16));
        assert_eq!(le(24), 11811, "300 dpi in pixels per metre");
        assert_eq!((le(40), le(44), le(48), le(52)), (0xFF0000, 0xFF00, 0xFF, 0xFF00_0000));
        // the bottom row comes first: green (half transparent), then blue
        assert_eq!(&d[124..132], &[0, 255, 0, 128, 255, 0, 0, 255]);
        // then the top row: red, transparent
        assert_eq!(&d[132..140], &[0, 0, 255, 255, 0, 0, 0, 0]);
    }
}
