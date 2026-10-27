use serde::{Deserialize, Serialize};
use std::io::Write;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{webview::DownloadEvent, Manager};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProductLink {
    pub id: String,
    pub sku: String,
    pub title: String,
    pub revision: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublishDraftInput {
    pub platform: String,
    pub title: String,
    pub caption: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishDraft {
    #[serde(flatten)]
    pub input: PublishDraftInput,
    pub revision: u32,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: String,
    #[serde(default)]
    pub created_at: u64,
    pub account_name: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub product: Option<ProductLink>,
    #[serde(default)]
    pub association_revision: u32,
    #[serde(default)]
    pub publish_draft: Option<PublishDraft>,
    pub filename: String,
    pub status: String,
    pub path: Option<PathBuf>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Downloads(pub Mutex<Store>);
#[derive(Default)]
pub struct Store {
    pub records: Vec<Download>,
    history_path: Option<PathBuf>,
    pub history_error: Option<String>,
    read_only: bool,
    pub exports: HashMap<String, PathBuf>,
    pending: HashMap<(String, String), Vec<String>>,
}

#[derive(Serialize, Deserialize)]
struct History {
    version: u32,
    records: Vec<Download>,
}

fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let mut store = Self {
            history_path: Some(path.clone()),
            ..Self::default()
        };
        let result = (|| -> Result<Vec<Download>, String> {
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(error) => return Err(error.to_string()),
            };
            let history: History = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if ![1, 2].contains(&history.version) {
                return Err("下载历史版本不受支持，请使用对应版本应用".into());
            }
            Ok(history.records)
        })();
        match result {
            Ok(mut records) => {
                let mut interrupted = false;
                for record in &mut records {
                    if record.status == "downloading" {
                        record.status = "failed".into();
                        record.error =
                            Some("上次运行结束时下载尚未完成，请在平台重新下载。".into());
                        interrupted = true;
                    }
                }
                store.records = records;
                if interrupted {
                    let _ = store.persist();
                }
            }
            Err(error) => {
                store.history_error = Some(format!("无法读取下载历史，原文件已保留：{error}"));
                store.read_only = true;
            }
        }
        store
    }

    pub fn link_product(
        &mut self,
        id: &str,
        revision: u32,
        product: Option<ProductLink>,
    ) -> Result<Download, String> {
        let index = self
            .records
            .iter()
            .position(|record| record.id == id)
            .ok_or("素材记录不存在")?;
        let previous = self.records[index].clone();
        if previous.status != "completed" {
            return Err("只能关联已保存的素材".into());
        }
        if previous.association_revision != revision {
            return Err("商品关联已变更，请刷新素材列表后重试".into());
        }
        self.records[index].association_revision =
            revision.checked_add(1).ok_or("关联版本已达到上限")?;
        self.records[index].product = product;
        let updated = self.records[index].clone();
        if let Err(error) = self.persist() {
            if let Some(record) = self.records.iter_mut().find(|record| record.id == id) {
                *record = previous;
            }
            return Err(format!("商品关联未保存：{error}"));
        }
        Ok(updated)
    }

    pub fn save_publish_draft(
        &mut self,
        id: &str,
        revision: u32,
        mut input: PublishDraftInput,
    ) -> Result<Download, String> {
        if !["", "jd", "douyin", "kuaishou", "xiaohongshu"].contains(&input.platform.as_str()) {
            return Err("目标平台无效".into());
        }
        input.title = input.title.trim().to_string();
        input.caption = input.caption.trim().to_string();
        if input.title.chars().count() > 120 || input.caption.chars().count() > 5000 {
            return Err("本地草稿最多保存 120 字标题、5000 字文案".into());
        }
        let index = self
            .records
            .iter()
            .position(|record| record.id == id)
            .ok_or("素材记录不存在")?;
        let previous = self.records[index].clone();
        if previous.status != "completed" {
            return Err("只能为已保存的视频准备发布草稿".into());
        }
        let video = previous
            .path
            .as_ref()
            .and_then(|path| path.extension())
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                ["mp4", "mov", "m4v", "webm"].contains(&ext.to_ascii_lowercase().as_str())
            });
        if !video {
            return Err("此素材不是支持的视频文件".into());
        }
        let current_revision = previous
            .publish_draft
            .as_ref()
            .map_or(0, |draft| draft.revision);
        if current_revision != revision {
            return Err("发布草稿已变更，当前输入已保留，请重新读取后再保存".into());
        }
        self.records[index].publish_draft = Some(PublishDraft {
            input,
            revision: revision.checked_add(1).ok_or("草稿版本已达到上限")?,
            updated_at: timestamp(),
        });
        let updated = self.records[index].clone();
        if let Err(error) = self.persist() {
            if let Some(record) = self.records.iter_mut().find(|record| record.id == id) {
                *record = previous;
            }
            return Err(format!("发布草稿未保存：{error}"));
        }
        Ok(updated)
    }

    fn persist(&mut self) -> Result<(), String> {
        while self.records.len() > 100 {
            let Some(index) = self
                .records
                .iter()
                .take(self.records.len() - 1)
                .position(|record| record.status != "downloading")
            else {
                break;
            };
            self.records.remove(index);
        }
        if self.read_only {
            return Err(self.history_error.clone().unwrap_or_default());
        }
        let result = (|| -> Result<(), String> {
            let path = self.history_path.as_ref().ok_or("下载历史路径未配置")?;
            let parent = path.parent().ok_or("下载历史目录无效")?;
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            let temp = parent.join(format!("downloads-{}.tmp", Uuid::new_v4()));
            let bytes = serde_json::to_vec(&History {
                version: 2,
                records: self.records.clone(),
            })
            .map_err(|e| e.to_string())?;
            let write = (|| -> std::io::Result<()> {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                std::fs::rename(&temp, path)
            })();
            if let Err(error) = write {
                let _ = std::fs::remove_file(&temp);
                return Err(error.to_string());
            }
            Ok(())
        })();
        self.history_error = result
            .as_ref()
            .err()
            .map(|e| format!("下载历史保存失败：{e}"));
        result
    }
}

pub fn report_popup_error(app: &tauri::AppHandle, account_name: &str, message: String) {
    if let Ok(mut store) = app.state::<Downloads>().0.lock() {
        store.records.push(Download {
            id: Uuid::new_v4().to_string(),
            created_at: timestamp(),
            account_name: account_name.into(),
            account_id: None,
            product: None,
            association_revision: 0,
            publish_draft: None,
            filename: "平台预览或下载窗口".into(),
            status: "failed".into(),
            path: None,
            error: Some(message),
        });
        let _ = store.persist();
    }
}

fn destination(directory: &Path, suggested: &Path) -> PathBuf {
    let name = suggested
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("video.mp4");
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':') {
                '_'
            } else {
                c
            }
        })
        .take(160)
        .collect();
    // A unique subdirectory preserves the platform's filename without overwriting files.
    directory.join(Uuid::new_v4().to_string()).join(
        if safe.is_empty() || safe == "." || safe == ".." {
            "video.mp4"
        } else {
            &safe
        },
    )
}

pub fn handle(webview: tauri::Webview, event: DownloadEvent<'_>, account_name: &str) -> bool {
    let state = webview.app_handle().state::<Downloads>();
    let Ok(mut store) = state.0.lock() else {
        return false;
    };
    match event {
        DownloadEvent::Requested {
            url,
            destination: target,
        } => {
            let id = Uuid::new_v4().to_string();
            let result = webview
                .app_handle()
                .path()
                .download_dir()
                .map_err(|e| e.to_string())
                .and_then(|directory| {
                    let path = destination(&directory.join("JD Affiliate"), target);
                    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                    Ok(path)
                });
            let (path, error) = match result {
                Ok(path) => (Some(path), None),
                Err(error) => (None, Some(format!("无法创建下载目录：{error}"))),
            };
            let filename = path
                .as_ref()
                .and_then(|p| p.file_name())
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let mut allowed = error.is_none();
            store.records.push(Download {
                id: id.clone(),
                created_at: timestamp(),
                account_name: account_name.into(),
                account_id: webview
                    .label()
                    .split('-')
                    .nth(1)
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .map(|id| id.to_string()),
                product: None,
                association_revision: 0,
                publish_draft: None,
                filename,
                status: if allowed { "downloading" } else { "failed" }.into(),
                path: path.clone(),
                error,
            });
            if let Err(error) = store.persist() {
                allowed = false;
                if let Some(record) = store.records.last_mut() {
                    record.status = "failed".into();
                    record.error = Some(format!("下载未开始，无法保存历史记录：{error}"));
                }
            }
            if let Some(path) = path.filter(|_| allowed) {
                *target = path;
                store
                    .pending
                    .entry((webview.label().into(), url.to_string()))
                    .or_default()
                    .push(id);
            }
            allowed
        }
        DownloadEvent::Finished { url, success, .. } => {
            let key = (webview.label().into(), url.to_string());
            let id = store.pending.get_mut(&key).and_then(|ids| {
                if ids.is_empty() {
                    None
                } else {
                    Some(ids.remove(0))
                }
            });
            if store.pending.get(&key).is_some_and(Vec::is_empty) {
                store.pending.remove(&key);
            }
            if let Some(record) = id.and_then(|id| store.records.iter_mut().find(|r| r.id == id)) {
                // macOS supplies no path in Finished; retain our Requested destination.
                let exists = record.path.as_ref().is_some_and(|p| p.is_file());
                record.status = if success && exists {
                    "completed"
                } else {
                    "failed"
                }
                .into();
                if record.status == "failed" {
                    record.error = Some("下载未完成或文件不可访问，请在平台重试。".into());
                }
            }
            let _ = store.persist();
            true
        }
        _ => true,
    }
}

fn saved_path<'a>(store: &'a Store, id: &str) -> Result<&'a Path, String> {
    let record = store
        .records
        .iter()
        .find(|r| r.id == id)
        .ok_or("下载记录不存在")?;
    if record.status != "completed" {
        return Err("文件尚未下载完成".into());
    }
    let path = record
        .path
        .as_ref()
        .filter(|p| p.is_file())
        .ok_or("文件已移动或删除")?;
    Ok(path)
}

pub fn reveal(store: &Store, id: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(saved_path(store, id)?)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn play(store: &Store, id: &str) -> Result<(), String> {
    let path = playable_path(store, id)?;
    std::process::Command::new("open")
        .args(["-a", "QuickTime Player"])
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn playable_path<'a>(store: &'a Store, id: &str) -> Result<&'a Path, String> {
    let path = saved_path(store, id)?;
    if !path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| ["mp4", "mov", "m4v"].contains(&ext.to_ascii_lowercase().as_str()))
    {
        return Err("此文件不是支持直接播放的视频，请在 Finder 中查看".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destinations_are_unique_and_preserve_extension_inside_download_directory() {
        let root = Path::new("/tmp/downloads");
        let a = destination(root, Path::new("../../video.mp4"));
        let b = destination(root, Path::new("../../video.mp4"));
        assert!(a.starts_with(root));
        assert_eq!(a.file_name().unwrap(), "video.mp4");
        assert_ne!(a, b);
        assert!(!destination(root, Path::new("bad\n:name.mp4"))
            .to_string_lossy()
            .contains('\n'));
    }
    #[test]
    fn reveal_rejects_unknown_and_incomplete_downloads() {
        let mut store = Store::default();
        assert!(reveal(&store, "missing").is_err());
        store.records.push(Download {
            id: "x".into(),
            created_at: timestamp(),
            account_name: "test".into(),
            account_id: None,
            product: None,
            association_revision: 0,
            publish_draft: None,
            filename: "x.mp4".into(),
            status: "downloading".into(),
            path: None,
            error: None,
        });
        assert!(reveal(&store, "x").is_err());
    }
    fn record(status: &str, path: Option<PathBuf>) -> Download {
        Download {
            id: Uuid::new_v4().to_string(),
            created_at: timestamp(),
            account_name: "测试账号".into(),
            account_id: None,
            product: None,
            association_revision: 0,
            publish_draft: None,
            filename: "视频.mp4".into(),
            status: status.into(),
            path,
            error: None,
        }
    }

    #[test]
    fn history_survives_restart_and_interrupted_downloads_are_not_reported_complete() {
        let directory = std::env::temp_dir().join(format!("jd-history-{}", Uuid::new_v4()));
        let path = directory.join("downloads.json");
        let mut store = Store::load(path.clone());
        let saved = record("completed", Some(directory.join("video.mp4")));
        let id = saved.id.clone();
        store.records.push(saved);
        store.records.push(record("downloading", None));
        store.persist().unwrap();
        drop(store);
        let loaded = Store::load(path.clone());
        assert_eq!(loaded.records[0].id, id);
        assert_eq!(loaded.records[0].status, "completed");
        assert_eq!(loaded.records[1].status, "failed");
        assert!(loaded.records[1]
            .error
            .as_ref()
            .unwrap()
            .contains("上次运行"));
        let again = Store::load(path);
        assert_eq!(again.records[1].status, "failed");
        assert!(saved_path(&again, &id)
            .unwrap_err()
            .contains("文件已移动或删除"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupted_or_newer_history_is_never_overwritten() {
        for bytes in [
            b"broken json".as_slice(),
            br#"{"version":99,"records":[]}"#.as_slice(),
        ] {
            let directory = std::env::temp_dir().join(format!("jd-history-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            let path = directory.join("downloads.json");
            std::fs::write(&path, bytes).unwrap();
            let mut store = Store::load(path.clone());
            assert!(store.history_error.is_some());
            store.records.push(record("completed", None));
            assert!(store.persist().is_err());
            assert_eq!(std::fs::read(path).unwrap(), bytes);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn playback_rejects_non_video_files_and_missing_files() {
        let directory = std::env::temp_dir().join(format!("jd-play-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("unsafe.command");
        std::fs::write(&file, b"test").unwrap();
        let mut store = Store::default();
        let item = record("completed", Some(file));
        let id = item.id.clone();
        store.records.push(item);
        assert!(playable_path(&store, &id).is_err());
        let video = directory.join("clip.MP4");
        std::fs::write(&video, b"test video").unwrap();
        store.records[0].path = Some(video.clone());
        assert_eq!(playable_path(&store, &id).unwrap(), video);
        std::fs::remove_file(video).unwrap();
        assert!(playable_path(&store, &id).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn product_associations_survive_restart_and_stale_updates_are_rejected() {
        let directory = std::env::temp_dir().join(format!("jd-link-{}", Uuid::new_v4()));
        let path = directory.join("downloads.json");
        let mut store = Store::load(path.clone());
        let item = record("completed", None);
        let id = item.id.clone();
        store.records.push(item);
        let linked = store
            .link_product(
                &id,
                0,
                Some(ProductLink {
                    id: "product-id".into(),
                    sku: "123456".into(),
                    title: "关联商品".into(),
                    revision: 3,
                }),
            )
            .unwrap();
        assert_eq!(linked.association_revision, 1);
        assert!(store.link_product(&id, 0, None).is_err());
        let mut restored = Store::load(path.clone());
        assert_eq!(restored.records[0].product.as_ref().unwrap().sku, "123456");
        assert_eq!(restored.records[0].product.as_ref().unwrap().revision, 3);
        restored.link_product(&id, 1, None).unwrap();
        let unlinked = Store::load(path);
        assert!(unlinked.records[0].product.is_none());
        assert_eq!(unlinked.records[0].association_revision, 2);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_association_save_rolls_back_and_incomplete_downloads_cannot_be_linked() {
        let directory = std::env::temp_dir().join(format!("jd-link-{}", Uuid::new_v4()));
        std::fs::write(&directory, b"directory blocker").unwrap();
        let mut store = Store::load(directory.join("downloads.json"));
        let item = record("completed", None);
        let id = item.id.clone();
        store.records.push(item);
        assert!(store
            .link_product(
                &id,
                0,
                Some(ProductLink {
                    id: "x".into(),
                    sku: "1".into(),
                    title: "test".into(),
                    revision: 1
                })
            )
            .is_err());
        assert!(store.records[0].product.is_none());
        assert_eq!(store.records[0].association_revision, 0);
        store.records[0].status = "downloading".into();
        assert!(store
            .link_product(&id, 0, None)
            .unwrap_err()
            .contains("只能关联"));
        std::fs::remove_file(directory).unwrap();
    }

    #[test]
    fn old_download_records_load_without_inventing_account_or_product_identity() {
        let json = r#"{"id":"old","createdAt":1,"accountName":"1","filename":"video.mp4","status":"completed","path":null,"error":null}"#;
        let record: Download = serde_json::from_str(json).unwrap();
        assert!(record.account_id.is_none());
        assert!(record.product.is_none());
        assert_eq!(record.association_revision, 0);
    }
    fn draft_input() -> PublishDraftInput {
        PublishDraftInput {
            platform: "jd".into(),
            title: " 标题 ".into(),
            caption: "第一段\n第二段".into(),
        }
    }

    #[test]
    fn publish_draft_persists_without_overwriting_product_associations() {
        let directory = std::env::temp_dir().join(format!("jd-draft-{}", Uuid::new_v4()));
        let path = directory.join("downloads.json");
        let mut store = Store::load(path.clone());
        let item = record("completed", Some(directory.join("clip.mp4")));
        let id = item.id.clone();
        store.records.push(item);
        store.save_publish_draft(&id, 0, draft_input()).unwrap();
        store
            .link_product(
                &id,
                0,
                Some(ProductLink {
                    id: "sku-id".into(),
                    sku: "123".into(),
                    title: "商品".into(),
                    revision: 1,
                }),
            )
            .unwrap();
        assert!(store.save_publish_draft(&id, 0, draft_input()).is_err());
        let result = store
            .save_publish_draft(
                &id,
                1,
                PublishDraftInput {
                    platform: "".into(),
                    title: "".into(),
                    caption: "".into(),
                },
            )
            .unwrap();
        assert!(result.product.is_some());
        assert_eq!(result.association_revision, 1);
        let loaded = Store::load(path.clone());
        assert_eq!(
            loaded.records[0].publish_draft.as_ref().unwrap().revision,
            2
        );
        assert_eq!(
            loaded.records[0]
                .publish_draft
                .as_ref()
                .unwrap()
                .input
                .platform,
            ""
        );
        assert_eq!(loaded.records[0].product.as_ref().unwrap().sku, "123");
        let envelope: History = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(envelope.version, 2);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn publish_draft_rejects_invalid_fields_non_video_and_failed_persistence() {
        let directory = std::env::temp_dir().join(format!("jd-draft-{}", Uuid::new_v4()));
        let mut store = Store::load(directory.join("downloads.json"));
        let item = record("completed", Some(directory.join("clip.mp4")));
        let id = item.id.clone();
        store.records.push(item);
        let mut bad = draft_input();
        bad.platform = "unknown".into();
        assert!(store.save_publish_draft(&id, 0, bad).is_err());
        let mut bad = draft_input();
        bad.title = "字".repeat(121);
        assert!(store.save_publish_draft(&id, 0, bad).is_err());
        let mut bad = draft_input();
        bad.caption = "字".repeat(5001);
        assert!(store.save_publish_draft(&id, 0, bad).is_err());
        store.records[0].path = Some(directory.join("clip.command"));
        assert!(store.save_publish_draft(&id, 0, draft_input()).is_err());
        store.records[0].path = Some(directory.join("clip.mp4"));
        std::fs::write(&directory, b"directory blocker").unwrap();
        assert!(store.save_publish_draft(&id, 0, draft_input()).is_err());
        assert!(store.records[0].publish_draft.is_none());
        std::fs::remove_file(directory).unwrap();
    }

    #[test]
    fn version_one_history_upgrades_when_first_draft_is_saved() {
        let directory = std::env::temp_dir().join(format!("jd-draft-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("downloads.json");
        let item = record("completed", Some(directory.join("clip.mp4")));
        let id = item.id.clone();
        std::fs::write(
            &path,
            serde_json::to_vec(&History {
                version: 1,
                records: vec![item],
            })
            .unwrap(),
        )
        .unwrap();
        let mut store = Store::load(path.clone());
        assert!(store.history_error.is_none());
        let saved = store.save_publish_draft(&id, 0, draft_input()).unwrap();
        assert_eq!(saved.publish_draft.as_ref().unwrap().input.title, "标题");
        assert_eq!(
            saved.publish_draft.as_ref().unwrap().input.caption,
            "第一段\n第二段"
        );
        let reopened = Store::load(path);
        assert_eq!(
            reopened.records[0]
                .publish_draft
                .as_ref()
                .unwrap()
                .input
                .title,
            "标题"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
