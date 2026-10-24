use rusqlite::Connection;
use std::path::Path;
use uuid::Uuid;

pub fn open(path: &Path) -> Result<Connection, String> {
    let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version > 0 && version < 3 {
        let backups = path.parent().ok_or("数据库目录无效")?.join("backups");
        std::fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
        conn.backup(
            rusqlite::MAIN_DB,
            backups.join(format!("v{}-before-v3-{}.sqlite3", version, Uuid::new_v4())),
            None,
        )
        .map_err(|e| format!("升级前备份失败，未升级数据库：{e}"))?;
    }
    crate::accounts::initialize(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn v2_upgrade_keeps_products_and_backup_failure_blocks_migration() {
        let directory =
            std::env::temp_dir().join(format!("jd-script-migration-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("accounts.sqlite3");
        let id;
        {
            let mut conn = Connection::open(&path).unwrap();
            crate::accounts::initialize(&mut conn).unwrap();
            crate::products::save(
                &conn,
                crate::products::ProductInput {
                    sku: "123".into(),
                    title: "升级前商品".into(),
                    url: "".into(),
                    specs: "规格".into(),
                    selling_points: "事实".into(),
                },
                None,
                None,
            )
            .unwrap();
            id = crate::products::list(&conn).unwrap().remove(0).id;
            conn.execute_batch("DROP TABLE prompt_versions; PRAGMA user_version=2;")
                .unwrap();
        }
        // A file at the backup directory location simulates an unusable backup destination.
        std::fs::write(directory.join("backups"), b"test blocker").unwrap();
        assert!(open(&path).is_err());
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(
                conn.pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                    .unwrap(),
                2
            );
        }
        std::fs::remove_file(directory.join("backups")).unwrap();
        {
            let conn = open(&path).unwrap();
            assert_eq!(crate::products::list(&conn).unwrap()[0].id, id);
            assert!(crate::prompts::list(&conn, &id).unwrap().is_empty());
            assert_eq!(
                conn.pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                    .unwrap(),
                3
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn v1_upgrade_preserves_accounts_and_creates_readable_backup() {
        let directory = std::env::temp_dir().join(format!("jd-migration-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("accounts.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE accounts(id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT INTO accounts VALUES ('d17ae122-924d-4851-9584-d740c9ca6529', 'jd', '既有账号', 1);
                PRAGMA user_version=1;").unwrap();
        }
        let conn = open(&path).unwrap();
        let account = crate::accounts::list(&conn).unwrap().accounts.remove(0);
        assert!(account.archived);
        assert_eq!(account.name, "既有账号");
        assert!(crate::products::list(&conn).unwrap().is_empty());
        let backup_path = std::fs::read_dir(directory.join("backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let backup = Connection::open(backup_path).unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            backup
                .query_row("SELECT name FROM accounts", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "既有账号"
        );
        drop(backup);
        drop(conn);
        drop(open(&path).unwrap());
        assert_eq!(
            std::fs::read_dir(directory.join("backups"))
                .unwrap()
                .count(),
            1
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
