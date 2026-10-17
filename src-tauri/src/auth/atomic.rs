use anyhow::{Context, Result};
use std::{fs, io::Write, path::Path};

/// Readers see either the old complete file or the new complete file. The
/// temporary credential file is private from creation, including before rename.
pub(crate) fn write_private(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().context("File has no parent directory")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        temporary.as_file().set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temporary.write_all(contents)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)
        .with_context(|| format!("Could not replace {}", path.display()))?;
    #[cfg(unix)] fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacing_a_file_preserves_complete_contents_and_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        write_private(&path, b"old").unwrap();
        write_private(&path, b"new credential").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new credential");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
}
