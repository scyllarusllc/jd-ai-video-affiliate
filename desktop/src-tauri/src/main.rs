use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{webview::NewWindowResponse, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;
mod accounts;
mod database;
mod downloads;
mod products;
mod prompts;
mod publish_package;

#[tauri::command]
async fn list_downloads(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, downloads::Downloads>,
) -> Result<serde_json::Value, String> {
    require_manager(&window)?;
    let store = state.0.lock().map_err(|_| "下载记录暂不可用")?;
    Ok(
        serde_json::json!({ "records": store.records.iter().rev().map(|record| {
            let mut value = serde_json::to_value(record).expect("download serialization");
            value["fileAvailable"] = serde_json::json!(record.path.as_ref().is_some_and(|path| path.is_file()));
            value
        }).collect::<Vec<_>>(), "error": store.history_error }),
    )
}

#[tauri::command]
async fn reveal_download(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, downloads::Downloads>,
    id: String,
) -> Result<(), String> {
    require_manager(&window)?;
    let store = state.0.lock().map_err(|_| "下载记录暂不可用")?;
    downloads::reveal(&store, &id)
}

#[tauri::command]
async fn play_download(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, downloads::Downloads>,
    id: String,
) -> Result<(), String> {
    require_manager(&window)?;
    let store = state.0.lock().map_err(|_| "下载记录暂不可用")?;
    downloads::play(&store, &id)
}

#[tauri::command]
async fn link_download_product(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, downloads::Downloads>,
    id: String,
    product_id: Option<String>,
    revision: u32,
) -> Result<downloads::Download, String> {
    require_manager(&window)?;
    let product = if let Some(product_id) = product_id {
        let product = products::list(&account_database(&app)?)?
            .into_iter()
            .find(|product| product.id == product_id)
            .ok_or("商品不存在，请重新读取商品列表")?;
        Some(downloads::ProductLink {
            id: product.id,
            sku: product.input.sku,
            title: product.input.title,
            revision: product.revision,
        })
    } else {
        None
    };
    let mut store = state.0.lock().map_err(|_| "下载记录暂不可用")?;
    store.link_product(&id, revision, product)
}

#[tauri::command]
async fn save_publish_draft(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, downloads::Downloads>,
    id: String,
    revision: u32,
    draft: downloads::PublishDraftInput,
) -> Result<downloads::Download, String> {
    require_manager(&window)?;
    state
        .0
        .lock()
        .map_err(|_| "下载记录暂不可用")?
        .save_publish_draft(&id, revision, draft)
}

#[tauri::command]
async fn export_publish_package(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    revision: u32,
    association_revision: u32,
) -> Result<publish_package::ExportResult, String> {
    require_manager(&window)?;
    let record = {
        let state = app.state::<downloads::Downloads>();
        let store = state.0.lock().map_err(|_| "下载记录暂不可用")?;
        publish_package::snapshot(&store.records, &id, revision, association_revision)?
    };
    let root = app
        .path()
        .download_dir()
        .map_err(|e| e.to_string())?
        .join("JD Affiliate 发布资料包");
    let result =
        tauri::async_runtime::spawn_blocking(move || publish_package::export(&root, &record))
            .await
            .map_err(|e| e.to_string())??;
    app.state::<downloads::Downloads>()
        .0
        .lock()
        .map_err(|_| "资料包已生成，但无法登记打开位置")?
        .exports
        .insert(id, result.path.clone());
    Ok(result)
}

#[tauri::command]
async fn reveal_publish_package(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    require_manager(&window)?;
    let state = app.state::<downloads::Downloads>();
    let store = state.0.lock().map_err(|_| "下载记录暂不可用")?;
    let path = store
        .exports
        .get(&id)
        .filter(|path| path.is_dir())
        .ok_or("本次运行尚无资料包，或文件夹已移动")?;
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn app_runtime(window: tauri::WebviewWindow) -> Result<&'static str, String> {
    require_manager(&window)?;
    Ok(if tauri::is_dev() {
        "development"
    } else {
        "packaged"
    })
}

fn allowed_popup(platform: &str, url: &tauri::Url) -> bool {
    if allowed_navigation(platform, url) {
        return true;
    }
    if url.scheme() == "blob" {
        return tauri::Url::parse(url.path())
            .is_ok_and(|origin| allowed_navigation(platform, &origin));
    }
    false
}

#[derive(Default)]
struct LoginStates(Mutex<HashMap<String, (String, Instant)>>);

#[tauri::command]
async fn request_login_sync(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    require_manager(&window)?;
    let mut errors = Vec::new();
    for (label, view) in app.webview_windows() {
        if label.starts_with("account-") {
            if let Err(error) = view.eval("window.dispatchEvent(new Event('jd-status-probe'))") {
                errors.push(error.to_string());
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("部分账号窗口检测失败：{}", errors.join("；")))
    }
}

#[tauri::command]
async fn account_login_states(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, LoginStates>,
) -> Result<HashMap<String, String>, String> {
    require_manager(&window)?;
    let states = state.0.lock().map_err(|_| "登录状态暂不可用")?;
    Ok(states
        .iter()
        .filter(|(id, (_, time))| {
            time.elapsed() < Duration::from_secs(10)
                && app.get_webview_window(&format!("account-{id}")).is_some()
        })
        .map(|(id, (status, _))| (id.clone(), status.clone()))
        .collect())
}

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
async fn rename_account(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    account_id: String,
    name: String,
    expected_name: String,
) -> Result<accounts::Account, String> {
    require_manager(&window)?;
    let account = accounts::rename(&account_database(&app)?, &account_id, &name, &expected_name)?;
    let id = Uuid::parse_str(&account.id)
        .map_err(|_| "账号标识无效")?
        .simple()
        .to_string();
    for (label, view) in app.webview_windows() {
        let title = if label == format!("account-{id}") {
            Some(format!(
                "{} · 独立账号窗口 · {}",
                if account.platform == "jd" {
                    "京东"
                } else {
                    "豆包"
                },
                account.name
            ))
        } else if label == format!("probe-{id}") {
            Some(format!("账号存储隔离验证 · {}", account.name))
        } else if label.starts_with(&format!("media-{id}-")) {
            Some(format!("{} · 平台预览与下载", account.name))
        } else {
            None
        };
        if let Some(title) = title {
            let _ = view.set_title(&title);
        }
    }
    Ok(account)
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
    let popup_app = app.clone();
    let popup_platform = platform.clone();
    let popup_name = account.name.clone();
    let download_name = account.name.clone();
    let builder = WebviewWindowBuilder::new(&app, &label, target)
        .title(title)
        .on_download(move |webview, event| downloads::handle(webview, event, &download_name))
        .on_new_window(move |url, features| {
            if !allowed_popup(&popup_platform, &url) {
                downloads::report_popup_error(
                    &popup_app,
                    &popup_name,
                    format!(
                        "平台弹窗被阻止（{}）；当前仅支持平台域名及其 blob 视频地址。",
                        url.host_str().unwrap_or(url.scheme())
                    ),
                );
                return NewWindowResponse::Deny;
            }
            let name = popup_name.clone();
            let policy = popup_platform.clone();
            let popup = WebviewWindowBuilder::new(
                &popup_app,
                format!("media-{}-{}", id.simple(), Uuid::new_v4().simple()),
                WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .window_features(features)
            .title(format!("{} · 平台预览与下载", popup_name))
            .inner_size(1000.0, 750.0)
            .on_navigation(move |url| url.as_str() == "about:blank" || allowed_popup(&policy, url))
            .on_download(move |webview, event| downloads::handle(webview, event, &name));
            #[cfg(target_os = "macos")]
            let popup = popup.data_store_identifier(*id.as_bytes());
            match popup.build() {
                Ok(window) => NewWindowResponse::Create { window },
                Err(error) => {
                    downloads::report_popup_error(
                        &popup_app,
                        &popup_name,
                        format!("无法打开平台窗口：{error}"),
                    );
                    NewWindowResponse::Deny
                }
            }
        })
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
            let token = Uuid::new_v4().simple().to_string();
            let script = include_str!("login-monitor.js").replace("__SESSION_TOKEN__", &token);
            let handle = app.clone();
            let key = id.simple().to_string();
            let load_handle = app.clone();
            let load_key = key.clone();
            builder
                .on_page_load(move |_, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Started {
                        if let Ok(mut states) = load_handle.state::<LoginStates>().0.lock() {
                            states.remove(&load_key);
                        }
                    }
                })
                .initialization_script_for_all_frames(script)
                .on_navigation(move |url| {
                    if url.host_str() == Some("session-status.invalid") {
                        let parts: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
                        if parts.len() == 2
                            && parts[0] == token
                            && ["logged_in", "logged_out", "unknown"].contains(&parts[1])
                        {
                            if let Ok(mut states) = handle.state::<LoginStates>().0.lock() {
                                states.insert(key.clone(), (parts[1].into(), Instant::now()));
                            }
                        }
                        return false;
                    }
                    allowed_popup(&platform, url)
                })
        };
        app.state::<LoginStates>()
            .0
            .lock()
            .map_err(|_| "登录状态暂不可用")?
            .remove(&id.simple().to_string());
        builder.build().map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(LoginStates::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_title(if tauri::is_dev() {
                    "京东助手 · 开发模式（代码自动更新）"
                } else {
                    "京东助手 · 打包应用"
                })?;
            }
            let path = app.path().app_data_dir()?.join("downloads.json");
            app.manage(downloads::Downloads(Mutex::new(downloads::Store::load(
                path,
            ))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_account,
            account_login_states,
            request_login_sync,
            list_downloads,
            reveal_download,
            play_download,
            link_download_product,
            save_publish_draft,
            app_runtime,
            export_publish_package,
            reveal_publish_package,
            list_accounts,
            create_account,
            rename_account,
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
