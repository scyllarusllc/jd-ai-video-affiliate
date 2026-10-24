use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProductInput {
    pub sku: String,
    pub title: String,
    pub url: String,
    pub specs: String,
    pub selling_points: String,
}

#[derive(Debug, Serialize)]
pub struct Product {
    pub id: String,
    #[serde(flatten)]
    pub input: ProductInput,
    pub revision: u32,
}

#[derive(Serialize)]
pub struct PreviewRow {
    pub line: u64,
    pub product: Option<ProductInput>,
    pub error: Option<String>,
}

pub fn list(conn: &Connection) -> Result<Vec<Product>, String> {
    let mut stmt = conn.prepare("SELECT id, sku, title, url, specs, selling_points, revision FROM products ORDER BY rowid DESC").map_err(err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Product {
                id: row.get(0)?,
                input: ProductInput {
                    sku: row.get(1)?,
                    title: row.get(2)?,
                    url: row.get(3)?,
                    specs: row.get(4)?,
                    selling_points: row.get(5)?,
                },
                revision: row.get(6)?,
            })
        })
        .map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

pub fn save(
    conn: &Connection,
    input: ProductInput,
    id: Option<String>,
    revision: Option<u32>,
) -> Result<(), String> {
    let input = validate(input)?;
    if let Some(id) = id {
        let id = Uuid::parse_str(&id)
            .map_err(|_| "商品标识无效")?
            .to_string();
        let revision = revision.ok_or("缺少商品版本，请重新读取后编辑")?;
        let count = conn.execute("UPDATE products SET sku=?1, title=?2, url=?3, specs=?4, selling_points=?5, revision=revision+1 WHERE id=?6 AND revision=?7",
            params![input.sku, input.title, input.url, input.specs, input.selling_points, id, revision]).map_err(err)?;
        if count != 1 {
            return Err("商品已变更或不存在，请重新读取后再保存".into());
        }
    } else {
        insert(conn, &input)?;
    }
    Ok(())
}

pub fn preview(conn: &Connection, content: &str) -> Result<Vec<PreviewRow>, String> {
    if content.len() > 1_048_576 {
        return Err("CSV 最大为 1 MiB".into());
    }
    let mut reader =
        csv::ReaderBuilder::new().from_reader(content.trim_start_matches('\u{feff}').as_bytes());
    let headers = reader.headers().map_err(|e| e.to_string())?;
    let expected = ["sku", "title", "url", "specs", "selling_points"];
    if headers.len() != expected.len()
        || !expected
            .iter()
            .all(|key| headers.iter().filter(|header| header == key).count() == 1)
    {
        return Err("CSV 表头需包含 sku,title,url,specs,selling_points，且每列只出现一次".into());
    }
    let headers = headers.clone();
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for record in reader.records() {
        if result.len() >= 500 {
            return Err("单次最多导入 500 个商品".into());
        }
        let line = match &record {
            Ok(record) => record.position().map(|p| p.line()).unwrap_or(0),
            Err(error) => error.position().map(|p| p.line()).unwrap_or(0),
        };
        let parsed = record
            .map_err(|e| e.to_string())
            .and_then(|r| {
                r.deserialize::<ProductInput>(Some(&headers))
                    .map_err(|e| e.to_string())
            })
            .and_then(validate);
        match parsed {
            Ok(product) => {
                let duplicate = conn
                    .query_row(
                        "SELECT 1 FROM products WHERE sku=?1",
                        [&product.sku],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(err)?
                    .is_some();
                let error = if !seen.insert(product.sku.clone()) {
                    Some("CSV 内 SKU 重复".into())
                } else if duplicate {
                    Some("SKU 已存在，请在商品列表中编辑".into())
                } else {
                    None
                };
                result.push(PreviewRow {
                    line,
                    product: Some(product),
                    error,
                });
            }
            Err(error) => result.push(PreviewRow {
                line,
                product: None,
                error: Some(error),
            }),
        }
    }
    if result.is_empty() {
        return Err("CSV 中没有商品记录".into());
    }
    Ok(result)
}

pub fn import(conn: &mut Connection, content: &str) -> Result<usize, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    // Validate again inside the transaction; preview is not permission to overwrite later changes.
    let rows = preview(&tx, content)?;
    if let Some(row) = rows.iter().find(|r| r.error.is_some()) {
        return Err(format!(
            "第 {} 行：{}。本批次未写入",
            row.line,
            row.error.as_deref().unwrap_or("无效数据")
        ));
    }
    for row in &rows {
        insert(&tx, row.product.as_ref().ok_or("商品资料缺失")?)?;
    }
    tx.commit().map_err(err)?;
    Ok(rows.len())
}

fn insert(conn: &Connection, input: &ProductInput) -> Result<(), String> {
    conn.execute("INSERT INTO products(id, sku, title, url, specs, selling_points) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![Uuid::new_v4().to_string(), input.sku, input.title, input.url, input.specs, input.selling_points]).map_err(err)?;
    Ok(())
}

fn validate(mut input: ProductInput) -> Result<ProductInput, String> {
    input.sku = input.sku.trim().into();
    input.title = input.title.trim().into();
    input.url = input.url.trim().into();
    input.specs = input.specs.trim().into();
    input.selling_points = input.selling_points.trim().into();
    if input.sku.is_empty()
        || input.sku.len() > 30
        || !input.sku.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("SKU 需为 1–30 位数字".into());
    }
    if input.title.is_empty()
        || input.title.chars().count() > 200
        || input.title.chars().any(char::is_control)
    {
        return Err("标题需为 1–200 个字符且不含控制字符".into());
    }
    if input.specs.chars().count() > 2000 || input.selling_points.chars().count() > 4000 {
        return Err("规格最多 2000 字，卖点最多 4000 字".into());
    }
    if input.url.len() > 2000 {
        return Err("商品链接过长".into());
    }
    if !input.url.is_empty() {
        let url: tauri::Url = input.url.parse().map_err(|_| "商品链接无效")?;
        let host = url.host_str().unwrap_or("");
        if url.scheme() != "https"
            || !(host == "jd.com" || host.ends_with(".jd.com"))
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("请填写京东 HTTPS 商品链接，不使用短链接或携带登录凭据的链接".into());
        }
    }
    Ok(input)
}

fn err(error: rusqlite::Error) -> String {
    match &error {
        rusqlite::Error::SqliteFailure(code, _) if code.extended_code == 2067 => {
            "SKU 已存在，请编辑现有商品".into()
        }
        _ => format!("商品数据库操作失败：{error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        crate::accounts::initialize(&mut c).unwrap();
        c
    }
    const HEADER: &str = "sku,title,url,specs,selling_points\n";
    #[test]
    fn quoted_csv_and_bom_keep_chinese_and_multiline_content() {
        let mut c = db();
        let csv = format!("\u{feff}{HEADER}123,\"测试商品，含逗号\",https://item.jd.com/123.html,标准款,\"卖点一\n卖点二\"\n");
        assert_eq!(import(&mut c, &csv).unwrap(), 1);
        let rows = list(&c).unwrap();
        assert_eq!(rows[0].input.selling_points, "卖点一\n卖点二");
        assert!(preview(&c, &csv).unwrap()[0].error.is_some());
    }
    #[test]
    fn bad_rows_and_duplicate_skus_prevent_entire_batch() {
        let mut c = db();
        let csv = format!("{HEADER}123,有效商品,,,\nabc,无效商品,,,\n");
        assert!(import(&mut c, &csv).is_err());
        assert!(list(&c).unwrap().is_empty());
        let duplicate = format!("{HEADER}123,商品甲,,,\n123,商品乙,,,\n");
        assert!(import(&mut c, &duplicate).is_err());
        assert!(list(&c).unwrap().is_empty());
        assert!(preview(&c, "sku,sku,url,specs,selling_points\n123,456,,,\n").is_err());
    }
    #[test]
    fn stale_edit_and_import_after_preview_cannot_overwrite() {
        let mut c = db();
        let csv = format!("{HEADER}123,原商品,,,\n");
        assert!(preview(&c, &csv).unwrap()[0].error.is_none());
        import(&mut c, &csv).unwrap();
        assert!(import(&mut c, &csv).is_err());
        let row = list(&c).unwrap().remove(0);
        let mut changed = row.input.clone();
        changed.title = "新标题".into();
        save(&c, changed, Some(row.id.clone()), Some(row.revision)).unwrap();
        assert!(save(&c, row.input, Some(row.id), Some(row.revision)).is_err());
        assert_eq!(list(&c).unwrap()[0].input.title, "新标题");
    }
    #[test]
    fn untrusted_urls_are_rejected() {
        let mut input = ProductInput {
            sku: "123".into(),
            title: "商品".into(),
            url: "https://jd.com.evil.example/".into(),
            specs: "".into(),
            selling_points: "".into(),
        };
        assert!(validate(input.clone()).is_err());
        input.url = "https://secret@item.jd.com/123.html".into();
        assert!(validate(input.clone()).is_err());
        input.url.clear();
        assert!(validate(input).is_ok());
    }
}
