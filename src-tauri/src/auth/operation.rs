//! Locks shared by the desktop, web and MCP processes. OS locks are released
//! automatically after a crash; a leftover lock file never means a busy lock.
use anyhow::{Context, Result};
use std::{fs::{self, File, OpenOptions}, path::Path};

pub(crate) fn lock_file(path: &Path) -> Result<File> {
    fs::create_dir_all(path.parent().context("Lock file has no parent")?)?;
    let file = OpenOptions::new().create(true).read(true).write(true).truncate(false).open(path)?;
    file.try_lock().context("Another account operation is in progress; retry after it finishes")?;
    Ok(file)
}

pub(crate) struct AuthGuard {
    _local: tokio::sync::MutexGuard<'static, ()>,
    _process: File,
}

pub(crate) async fn lock_auth() -> Result<AuthGuard> {
    let local = super::AUTH_OPERATION_LOCK.lock().await;
    let process = lock_file(&super::get_config_dir()?.join("auth-operation.lock"))?;
    Ok(AuthGuard { _local: local, _process: process })
}

pub(crate) fn try_lock_auth() -> Result<AuthGuard> {
    let local = super::AUTH_OPERATION_LOCK.try_lock().context("Account operation in progress; retry refresh")?;
    let process = lock_file(&super::get_config_dir()?.join("auth-operation.lock"))?;
    Ok(AuthGuard { _local: local, _process: process })
}

#[cfg(test)]
mod tests {
    #[test]
    fn lock_is_exclusive_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("operation.lock");
        let guard = super::lock_file(&path).unwrap();
        assert!(super::lock_file(&path).is_err());
        drop(guard);
        assert!(super::lock_file(&path).is_ok());
    }
}
