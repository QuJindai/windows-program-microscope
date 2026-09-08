//! Read-only PE header inspection. Never executes or maps the target image.
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn read_at(file: &mut File, at: u64, len: usize, size: u64) -> Result<Vec<u8>, String> {
    if at.checked_add(len as u64).is_none_or(|end| end > size) {
        return Err("Truncated PE header or section table".into());
    }
    file.seek(SeekFrom::Start(at)).map_err(|e| e.to_string())?;
    let mut bytes = vec![0; len];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
pub fn inspect(path: &Path) -> Result<Value, String> {
    if !path.is_absolute() {
        return Err("Executable path must be absolute".into());
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(path.components().next(),Some(Component::Prefix(prefix)) if matches!(prefix.kind(),Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return Err("PE inspection requires a local drive path; network and device paths are unavailable".into());
        }
    }
    let mut file = File::open(path).map_err(|e| format!("Cannot open executable: {e}"))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Executable must be a regular file".into());
    }
    let size = meta.len();
    let dos = read_at(&mut file, 0, 64, size)?;
    if &dos[..2] != b"MZ" {
        return Err("File is not a PE executable (missing DOS signature)".into());
    }
    let offset = u32_at(&dos, 60) as u64;
    if offset < 64 {
        return Err("Invalid PE header offset".into());
    }
    let coff = read_at(&mut file, offset, 24, size)?;
    if &coff[..4] != b"PE\0\0" {
        return Err("File is not a PE executable (missing PE signature)".into());
    }
    let machine = u16_at(&coff, 4);
    let count = u16_at(&coff, 6) as usize;
    let optional_size = u16_at(&coff, 20) as usize;
    if count == 0 || count > 96 || !(70..=4096).contains(&optional_size) {
        return Err("Invalid PE section count or optional header size".into());
    }
    let optional = read_at(&mut file, offset + 24, optional_size, size)?;
    let magic = u16_at(&optional, 0);
    let (format, image_base) = match magic {
        0x10b => ("PE32", u32_at(&optional, 28) as u64),
        0x20b => (
            "PE32+",
            u64::from_le_bytes(optional[24..32].try_into().unwrap()),
        ),
        _ => return Err("Unsupported PE optional header magic".into()),
    };
    let table = read_at(
        &mut file,
        offset + 24 + optional_size as u64,
        count * 40,
        size,
    )?;
    let mut sections = Vec::new();
    for row in table.chunks_exact(40) {
        let raw_size = u32_at(row, 16);
        let raw_offset = u32_at(row, 20);
        if raw_size > 0 && (raw_offset as u64 + raw_size as u64) > size {
            return Err("PE section extends beyond file".into());
        }
        let name = String::from_utf8_lossy(&row[..8])
            .trim_end_matches('\0')
            .to_owned();
        sections.push(json!({"name":name,"virtual_size":u32_at(row,8),"virtual_address":u32_at(row,12),"raw_size":raw_size,"raw_offset":raw_offset,"characteristics":u32_at(row,36)}));
    }
    let arch = match machine {
        0x14c => "x86",
        0x8664 => "x64",
        0xaa64 => "arm64",
        0x1c0 | 0x1c4 => "arm",
        _ => "unknown",
    };
    Ok(
        json!({"available":true,"path":path.to_string_lossy(),"name":path.file_name().unwrap_or_default().to_string_lossy(),"file_size":size,"machine":machine,"arch":arch,"format":format,"entry_point_rva":u32_at(&optional,16),"image_base":format!("0x{image_base:X}"),"subsystem":u16_at(&optional,68),"sections":sections,"capabilities":["headers","sections"]}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_real_header_and_rejects_out_of_bounds_sections() {
        let path = std::env::temp_dir().join(format!("{}.exe", crate::runtime::new_id()));
        let mut bytes = vec![0u8; 1024];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        bytes[68..70].copy_from_slice(&0x8664u16.to_le_bytes());
        bytes[70..72].copy_from_slice(&1u16.to_le_bytes());
        bytes[84..86].copy_from_slice(&240u16.to_le_bytes());
        bytes[88..90].copy_from_slice(&0x20bu16.to_le_bytes());
        bytes[328..333].copy_from_slice(b".text");
        bytes[344..348].copy_from_slice(&512u32.to_le_bytes());
        bytes[348..352].copy_from_slice(&512u32.to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();
        let pe = inspect(&path).unwrap();
        assert_eq!(pe["arch"], "x64");
        assert_eq!(pe["sections"][0]["name"], ".text");
        bytes[344..348].copy_from_slice(&1024u32.to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();
        assert!(inspect(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
