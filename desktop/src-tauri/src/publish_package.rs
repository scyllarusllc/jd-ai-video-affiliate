use crate::downloads::Download;
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: PathBuf,
    pub missing_fields: Vec<String>,
}

pub fn snapshot(
    records: &[Download],
    id: &str,
    revision: u32,
    association_revision: u32,
) -> Result<Download, String> {
    let record = records
        .iter()
        .find(|record| record.id == id)
        .ok_or("素材记录不存在")?;
    let draft = record.publish_draft.as_ref().ok_or("请先保存发布草稿")?;
    if draft.revision != revision || record.association_revision != association_revision {
        return Err("草稿或商品关联已变更，请核对最新资料后重新导出".into());
    }
    Ok(record.clone())
}

pub fn export(root: &Path, record: &Download) -> Result<ExportResult, String> {
    if record.status != "completed" {
        return Err("视频尚未下载完成".into());
    }
    let draft = record.publish_draft.as_ref().ok_or("请先保存发布草稿")?;
    let source = record.path.as_ref().ok_or("视频文件路径缺失")?;
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["mp4", "mov", "m4v", "webm"].contains(&extension.as_str()) {
        return Err("此文件不是支持的视频格式".into());
    }
    let mut input =
        fs::File::open(source).map_err(|e| format!("无法读取视频文件（可能已移动或删除）：{e}"))?;
    let original = input.metadata().map_err(|e| e.to_string())?;
    if !original.is_file() || original.len() == 0 {
        return Err("视频文件为空或不可访问".into());
    }
    let mut missing_fields = Vec::new();
    if record.product.is_none() {
        missing_fields.push("关联商品".into());
    }
    if draft.input.platform.is_empty() {
        missing_fields.push("目标平台".into());
    }
    if draft.input.title.trim().is_empty() {
        missing_fields.push("发布标题".into());
    }
    if draft.input.caption.trim().is_empty() {
        missing_fields.push("发布文案".into());
    }
    fs::create_dir_all(root).map_err(|e| format!("无法创建资料包目录：{e}"))?;
    let id = Uuid::new_v4();
    let temporary = root.join(format!(".export-{id}"));
    let destination = root.join(format!("发布资料包-{id}"));
    fs::create_dir(&temporary).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let video_name = format!("视频.{extension}");
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(temporary.join(&video_name))
            .map_err(|e| e.to_string())?;
        let copied =
            std::io::copy(&mut input, &mut output).map_err(|e| format!("复制视频失败：{e}"))?;
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string())?;
        let after = input.metadata().map_err(|e| e.to_string())?;
        if copied != original.len()
            || after.len() != original.len()
            || after.modified().ok() != original.modified().ok()
        {
            return Err("复制期间原视频发生变化，请重试".into());
        }
        let platform = match draft.input.platform.as_str() {
            "jd" => "京东",
            "douyin" => "抖音",
            "kuaishou" => "快手",
            "xiaohongshu" => "小红书",
            _ => "尚未选择",
        };
        fs::write(
            temporary.join("发布文案.txt"),
            format!(
                "目标平台：{platform}\n\n标题：\n{}\n\n文案：\n{}\n",
                draft.input.title, draft.input.caption
            ),
        )
        .map_err(|e| e.to_string())?;
        let product = serde_json::json!({ "product": record.product, "note": "关联时保存的名称、SKU 与版本摘要；未关联商品时 product 为 null。" });
        fs::write(
            temporary.join("商品摘要.json"),
            serde_json::to_vec_pretty(&product).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let manifest = serde_json::json!({ "schemaVersion": 1, "sourceId": record.id, "videoFile": video_name,
            "draft": draft, "associationRevision": record.association_revision, "missingFields": missing_fields });
        fs::write(
            temporary.join("资料清单.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let missing = if missing_fields.is_empty() {
            "本地资料齐全，请在目标平台人工核对。".into()
        } else {
            format!("资料待补充：{}。", missing_fields.join("、"))
        };
        fs::write(temporary.join("使用说明.txt"), format!("发布资料包\n\n{missing}\n\n视频文件是原下载视频的副本，原文件仍保留在原位置。\n发布文案.txt 保存导出时已保存的标题与文案。\n商品摘要.json 保存关联时的商品名称、SKU 和版本。\n资料清单.json 记录本次导出的草稿版本与缺少的资料。\n\n请在目标平台手动上传视频、填写文案并核对商品；此资料包不代表已发布。\n修改草稿后可再次导出，每次生成新的文件夹。\n")).map_err(|e| e.to_string())?;
        if destination.exists() {
            return Err("资料包目录已存在，请重试".into());
        }
        fs::rename(&temporary, &destination).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error);
    }
    Ok(ExportResult {
        path: destination,
        missing_fields,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(directory: &Path) -> Download {
        serde_json::from_value(serde_json::json!({ "id":"source-id", "createdAt":1, "accountName":"账号", "filename":"clip.mp4", "status":"completed",
            "path":directory.join("source.mp4"), "error":null,
            "publishDraft": { "platform":"jd", "title":"标题", "caption":"第一行\n第二行", "revision":2, "updatedAt":1 }
        })).unwrap()
    }
    #[test]
    fn exports_saved_snapshot_and_exact_video_bytes_without_overwriting_previous_package() {
        let directory = std::env::temp_dir().join(format!("jd-export-test-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let source = b"verified copy fixture";
        fs::write(directory.join("source.mp4"), source).unwrap();
        let record = fixture(&directory);
        let root = directory.join("exports");
        let a = export(&root, &record).unwrap();
        let b = export(&root, &record).unwrap();
        assert_ne!(a.path, b.path);
        assert_eq!(fs::read(a.path.join("视频.mp4")).unwrap(), source);
        assert_eq!(fs::read(directory.join("source.mp4")).unwrap(), source);
        assert_eq!(a.missing_fields, vec!["关联商品"]);
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(a.path.join("资料清单.json")).unwrap()).unwrap();
        assert_eq!(manifest["draft"]["revision"], 2);
        assert_eq!(manifest["draft"]["caption"], "第一行\n第二行");
        assert_eq!(fs::read_dir(&a.path).unwrap().count(), 5);
        assert!(!fs::read_dir(root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with('.')));
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn rejects_stale_metadata_missing_source_and_unprepared_downloads() {
        let directory = std::env::temp_dir().join(format!("jd-export-test-{}", Uuid::new_v4()));
        let mut record = fixture(&directory);
        assert!(snapshot(&[record.clone()], &record.id, 1, 0).is_err());
        assert!(snapshot(&[record.clone()], &record.id, 2, 1).is_err());
        assert!(export(&directory.join("exports"), &record).is_err());
        assert!(!directory.exists());
        record.status = "downloading".into();
        assert!(export(&directory, &record).is_err());
        record.publish_draft = None;
        assert!(snapshot(&[record.clone()], &record.id, 0, 0).is_err());
    }
    #[test]
    #[ignore = "requires JD_EXPORT_SMOKE_HISTORY and JD_EXPORT_SMOKE_ROOT"]
    fn real_saved_video_exports_with_matching_bytes_and_saved_metadata() {
        let history_path =
            std::env::var_os("JD_EXPORT_SMOKE_HISTORY").expect("set JD_EXPORT_SMOKE_HISTORY");
        let root = PathBuf::from(
            std::env::var_os("JD_EXPORT_SMOKE_ROOT").expect("set JD_EXPORT_SMOKE_ROOT"),
        );
        let history: serde_json::Value =
            serde_json::from_slice(&fs::read(history_path).unwrap()).unwrap();
        let record = history["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| serde_json::from_value::<Download>(value.clone()).ok())
            .find(|record| {
                record.status == "completed"
                    && record.publish_draft.is_some()
                    && record.path.as_ref().is_some_and(|path| path.is_file())
            })
            .expect("history must contain a saved video with a publication draft");
        let result = export(&root, &record).unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(result.path.join("资料清单.json")).unwrap()).unwrap();
        let source = record.path.as_ref().unwrap();
        let target = result.path.join(manifest["videoFile"].as_str().unwrap());
        assert_eq!(fs::read(source).unwrap(), fs::read(target).unwrap());
        assert_eq!(
            manifest["draft"]["title"],
            record.publish_draft.as_ref().unwrap().input.title
        );
        assert_eq!(fs::read_dir(&result.path).unwrap().count(), 5);
        println!("Verified real-video package: {}", result.path.display());
    }
}
