use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Account {
    pub id: String,
    pub platform: String,
    pub name: String,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStore {
    pub accounts: Vec<Account>,
    pub legacy_imported: bool,
}

pub fn initialize(conn: &mut Connection) -> Result<(), String> {
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(err)?;
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(err)?;
    if version > 3 {
        return Err("数据库来自更新版本，请使用对应版本应用打开".into());
    }
    if version == 3 {
        return Ok(());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            platform TEXT NOT NULL CHECK(platform IN ('doubao', 'jd')),
            name TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))
         );
         CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            sku TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            specs TEXT NOT NULL,
            selling_points TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1
         );
         CREATE TABLE IF NOT EXISTS prompt_versions (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL REFERENCES products(id),
            version INTEGER NOT NULL,
            product_revision INTEGER NOT NULL,
            template_id TEXT NOT NULL,
            template_version INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            body TEXT NOT NULL,
            request_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            UNIQUE(product_id, version)
         );
         PRAGMA user_version = 3;",
    )
    .map_err(err)?;
    tx.commit().map_err(err)
}

pub fn list(conn: &Connection) -> Result<AccountStore, String> {
    let mut stmt = conn
        .prepare("SELECT id, platform, name, archived FROM accounts ORDER BY rowid")
        .map_err(err)?;
    let rows = stmt.query_map([], read_account).map_err(err)?;
    let accounts = rows.collect::<Result<Vec<_>, _>>().map_err(err)?;
    Ok(AccountStore {
        accounts,
        legacy_imported: imported(conn)?,
    })
}

pub fn get(conn: &Connection, id: &str) -> Result<Account, String> {
    let id = canonical_id(id)?;
    conn.query_row(
        "SELECT id, platform, name, archived FROM accounts WHERE id = ?1",
        [id],
        read_account,
    )
    .optional()
    .map_err(err)?
    .ok_or_else(|| "账号不存在".into())
}

pub fn create(conn: &Connection, platform: &str, name: &str) -> Result<Account, String> {
    let account = validate(Account {
        id: Uuid::new_v4().to_string(),
        platform: platform.into(),
        name: name.into(),
        archived: false,
    })?;
    conn.execute(
        "INSERT INTO accounts(id, platform, name) VALUES (?1, ?2, ?3)",
        params![account.id, account.platform, account.name],
    )
    .map_err(err)?;
    Ok(account)
}

pub fn rename(
    conn: &Connection,
    id: &str,
    name: &str,
    expected_name: &str,
) -> Result<Account, String> {
    let mut account = get(conn, id)?;
    account.name = name.into();
    let account = validate(account)?;
    let count = conn
        .execute(
            "UPDATE accounts SET name = ?1 WHERE id = ?2 AND name = ?3",
            params![account.name, account.id, expected_name],
        )
        .map_err(err)?;
    if count != 1 {
        return Err("账号名称已变更，请刷新后重新编辑".into());
    }
    get(conn, &account.id)
}

pub fn archive(conn: &Connection, id: &str, archived: bool) -> Result<(), String> {
    let id = canonical_id(id)?;
    let count = conn
        .execute(
            "UPDATE accounts SET archived = ?1 WHERE id = ?2",
            params![archived, id],
        )
        .map_err(err)?;
    if count != 1 {
        return Err("账号不存在".into());
    }
    Ok(())
}

pub fn import_legacy(conn: &mut Connection, accounts: Vec<Account>) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    if imported(&tx)? {
        return Ok(());
    }
    for raw in accounts {
        let account = validate(raw)?;
        let existing = tx
            .query_row(
                "SELECT platform, name FROM accounts WHERE id = ?1",
                [&account.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(err)?;
        if let Some((platform, name)) = existing {
            if platform != account.platform || name != account.name {
                return Err("旧账号标识与现有账号冲突，迁移未写入，请保留旧数据并核对".into());
            }
        } else {
            tx.execute(
                "INSERT INTO accounts(id, platform, name, archived) VALUES (?1, ?2, ?3, 0)",
                params![account.id, account.platform, account.name],
            )
            .map_err(err)?;
        }
    }
    tx.execute(
        "INSERT INTO metadata(key, value) VALUES ('legacy_imported', '1')",
        [],
    )
    .map_err(err)?;
    tx.commit().map_err(err)
}

fn imported(conn: &Connection) -> Result<bool, String> {
    Ok(conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'legacy_imported'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(err)?
        .as_deref()
        == Some("1"))
}

fn canonical_id(id: &str) -> Result<String, String> {
    let uuid = Uuid::parse_str(id).map_err(|_| "账号标识无效")?;
    if uuid.is_nil() {
        return Err("账号标识不可为空 UUID".into());
    }
    Ok(uuid.to_string())
}

fn validate(mut account: Account) -> Result<Account, String> {
    account.id = canonical_id(&account.id)?;
    account.name = account.name.trim().to_string();
    if !matches!(account.platform.as_str(), "doubao" | "jd") {
        return Err("不支持的平台".into());
    }
    if account.name.is_empty()
        || account.name.chars().count() > 60
        || account.name.chars().any(char::is_control)
    {
        return Err("账号名称需为 1–60 个字符，且不含控制字符".into());
    }
    Ok(account)
}

fn read_account(row: &rusqlite::Row<'_>) -> rusqlite::Result<Account> {
    Ok(Account {
        id: row.get(0)?,
        platform: row.get(1)?,
        name: row.get(2)?,
        archived: row.get(3)?,
    })
}

fn err(error: rusqlite::Error) -> String {
    format!("账号数据库操作失败：{error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&mut conn).unwrap();
        conn
    }
    #[test]
    fn invalid_import_rolls_back_all_rows_and_can_be_retried() {
        let mut conn = database();
        let valid = Account {
            id: Uuid::new_v4().to_string(),
            platform: "doubao".into(),
            name: "旧账号 A".into(),
            archived: false,
        };
        let mut invalid = valid.clone();
        invalid.id = "invalid".into();
        assert!(import_legacy(&mut conn, vec![valid.clone(), invalid]).is_err());
        assert!(list(&conn).unwrap().accounts.is_empty());
        assert!(!list(&conn).unwrap().legacy_imported);
        import_legacy(&mut conn, vec![valid.clone()]).unwrap();
        assert_eq!(list(&conn).unwrap().accounts[0].id, valid.id);
        archive(&conn, &valid.id, true).unwrap();
        import_legacy(&mut conn, vec![valid.clone()]).unwrap();
        assert!(get(&conn, &valid.id).unwrap().archived);
        archive(&conn, &valid.id, false).unwrap();
        assert_eq!(get(&conn, &valid.id).unwrap().id, valid.id);
    }
    #[test]
    fn conflicting_legacy_identity_never_changes_existing_account() {
        let mut conn = database();
        let account = create(&conn, "jd", "京东 A").unwrap();
        let mut conflict = account.clone();
        conflict.platform = "doubao".into();
        assert!(import_legacy(&mut conn, vec![conflict]).is_err());
        assert_eq!(get(&conn, &account.id).unwrap().platform, "jd");
        assert!(!list(&conn).unwrap().legacy_imported);
    }
    #[test]
    fn reopening_database_keeps_identity_and_rejects_future_schema() {
        let path = std::env::temp_dir().join(format!("jd-accounts-{}.sqlite3", Uuid::new_v4()));
        let id;
        {
            let mut conn = Connection::open(&path).unwrap();
            initialize(&mut conn).unwrap();
            id = create(&conn, "doubao", "豆包 A").unwrap().id;
            assert!(create(&conn, "unknown", "A").is_err());
            assert!(create(&conn, "jd", " ").is_err());
        }
        {
            let mut conn = Connection::open(&path).unwrap();
            initialize(&mut conn).unwrap();
            assert_eq!(list(&conn).unwrap().accounts[0].id, id);
            conn.pragma_update(None, "user_version", 99).unwrap();
            assert!(initialize(&mut conn).is_err());
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn rename_preserves_account_identity_and_rejects_invalid_or_stale_edits() {
        let conn = database();
        let original = create(&conn, "doubao", "账号 A").unwrap();
        archive(&conn, &original.id, true).unwrap();
        let updated = rename(&conn, &original.id, " 新名称 ", &original.name).unwrap();
        assert_eq!(updated.name, "新名称");
        assert_eq!(updated.id, original.id);
        assert_eq!(updated.platform, original.platform);
        assert!(updated.archived);
        assert!(rename(&conn, &original.id, "覆盖", &original.name).is_err());
        for invalid in [
            "".to_string(),
            " ".into(),
            "名称\n控制字符".into(),
            "字".repeat(61),
        ] {
            assert!(rename(&conn, &original.id, &invalid, "新名称").is_err());
        }
        assert_eq!(get(&conn, &original.id).unwrap().name, "新名称");
    }
}
