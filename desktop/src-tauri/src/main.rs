use tauri::{webview::NewWindowResponse, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;
mod accounts;
mod database;
mod products;
mod prompts;

#[tauri::command]
async fn list_prompt_templates(
    window: tauri::WebviewWindow,
) -> Result<Vec<prompts::Template>, String> {
    require_manager(&window)?;
    Ok(prompts::templates())
}

#[tauri::command]
async fn generate_prompt(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    product_id: String,
    template_id: String,
) -> Result<prompts::Draft, String> {
    require_manager(&window)?;
    prompts::generate(&account_database(&app)?, &product_id, &template_id)
}

#[tauri::command]
async fn save_prompt_version(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    product_id: String,
    template_id: String,
    product_revision: u32,
    body: String,
    request_id: String,
) -> Result<prompts::PromptVersion, String> {
    require_manager(&window)?;
    prompts::save(
        &mut account_database(&app)?,
        &product_id,
        &template_id,
        product_revision,
        &body,
        &request_id,
    )
}

#[tauri::command]
async fn list_prompt_versions(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    product_id: String,
) -> Result<Vec<prompts::PromptVersion>, String> {
    require_manager(&window)?;
    prompts::list(&account_database(&app)?, &product_id)
}

fn require_manager(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅本地管理窗口可执行账号操作".into());
    }
    Ok(())
}

fn account_database(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    database::open(&directory.join("accounts.sqlite3"))
}

#[tauri::command]
async fn list_products(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<products::Product>, String> {
    require_manager(&window)?;
    products::list(&account_database(&app)?)
}

#[tauri::command]
async fn save_product(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    product: products::ProductInput,
    id: Option<String>,
    revision: Option<u32>,
) -> Result<(), String> {
    require_manager(&window)?;
    products::save(&account_database(&app)?, product, id, revision)
}

#[tauri::command]
async fn preview_products_csv(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    content: String,
) -> Result<Vec<products::PreviewRow>, String> {
    require_manager(&window)?;
    products::preview(&account_database(&app)?, &content)
}

#[tauri::command]
async fn import_products_csv(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    content: String,
) -> Result<usize, String> {
    require_manager(&window)?;
    products::import(&mut account_database(&app)?, &content)
}

#[tauri::command]
async fn list_accounts(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<accounts::AccountStore, String> {
    require_manager(&window)?;
    accounts::list(&account_database(&app)?)
}

#[tauri::command]
async fn create_account(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    platform: String,
    name: String,
) -> Result<accounts::Account, String> {
    require_manager(&window)?;
    accounts::create(&account_database(&app)?, &platform, &name)
}

#[tauri::command]
async fn import_legacy_accounts(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    accounts: Vec<accounts::Account>,
) -> Result<(), String> {
    require_manager(&window)?;
    accounts::import_legacy(&mut account_database(&app)?, accounts)
}

#[tauri::command]
async fn archive_account(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    account_id: String,
    archived: bool,
) -> Result<(), String> {
    require_manager(&window)?;
    // Preserve data stores. Close active windows before archiving to avoid stale UI actions.
    if archived {
        let id = Uuid::parse_str(&account_id).map_err(|_| "账号标识无效")?;
        for prefix in ["probe", "account"] {
            if let Some(view) = app.get_webview_window(&format!("{prefix}-{}", id.simple())) {
                return Err(format!(
                    "请先关闭账号窗口：{}",
                    view.title().unwrap_or_default()
                ));
            }
        }
    }
    accounts::archive(&account_database(&app)?, &account_id, archived)
}

fn platform_url(platform: &str) -> Result<&'static str, String> {
    match platform {
        "doubao" => Ok("https://www.doubao.com/chat/"),
        "jd" => Ok("https://dr.jd.com/"),
        _ => Err("不支持的平台".into()),
    }
}

fn allowed_navigation(platform: &str, url: &tauri::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    let domains: &[&str] = match platform {
        "doubao" => &["doubao.com", "bytedance.com"],
        "jd" => &["jd.com", "360buylogin.com"],
        _ => return false,
    };
    domains
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

#[tauri::command]
async fn open_account(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    account_id: String,
    probe: bool,
) -> Result<(), String> {
    require_manager(&window)?;
    let account = accounts::get(&account_database(&app)?, &account_id)?;
    if account.archived {
        return Err("账号已归档，请先恢复".into());
    }
    let platform = account.platform;
    let url = platform_url(&platform)?;
    let id = Uuid::parse_str(&account_id).map_err(|_| "账号标识无效")?;
    let label = format!(
        "{}-{}",
        if probe { "probe" } else { "account" },
        id.simple()
    );
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let target = if probe {
        WebviewUrl::App("probe.html".into())
    } else {
        WebviewUrl::External(url.parse().map_err(|_| "平台地址无效")?)
    };
    let title = format!(
        "{} · {}",
        if probe {
            "账号存储隔离验证"
        } else if platform == "doubao" {
            "豆包 · 独立账号窗口"
        } else {
            "京东 · 独立账号窗口"
        },
        account.name
    );
    let builder = WebviewWindowBuilder::new(&app, &label, target)
        .title(title)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .inner_size(1080.0, 780.0);
    // Stable window API; no experimental child webviews. macOS 14+ is required.
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(*id.as_bytes());
    #[cfg(not(target_os = "macos"))]
    return Err("此验证版仅支持 macOS 14 及以上".into());
    #[cfg(target_os = "macos")]
    {
        let builder = if probe {
            builder
        } else {
            builder.on_navigation(move |url| allowed_navigation(&platform, url))
        };
        builder.build().map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_account,
            list_accounts,
            create_account,
            import_legacy_accounts,
            archive_account,
            list_products,
            save_product,
            preview_products_csv,
            import_products_csv,
            list_prompt_templates,
            generate_prompt,
            save_prompt_version,
            list_prompt_versions
        ])
        .run(tauri::generate_context!())
        .expect("desktop application failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_rejects_lookalikes_and_non_https() {
        for value in [
            "https://jd.com.evil.example/",
            "https://eviljd.com/",
            "http://dr.jd.com/",
            "file:///etc/passwd",
        ] {
            assert!(!allowed_navigation("jd", &value.parse().unwrap()));
        }
        assert!(allowed_navigation(
            "jd",
            &"https://passport.jd.com/".parse().unwrap()
        ));
        assert!(!allowed_navigation(
            "doubao",
            &"https://dr.jd.com/".parse().unwrap()
        ));
        assert!(platform_url("unknown").is_err());
    }
}
