import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App as AntdApp, Button, Modal, Progress, Upload } from 'antd';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  FilePdfOutlined,
  FilePptOutlined,
  FileTextOutlined,
  FileWordOutlined,
  FileExcelOutlined,
  FileZipOutlined,
  InboxOutlined,
} from '@ant-design/icons';

import { api } from '../api.js';
import { formatFileSize } from '../utils/format.js';
import { ACCEPTED_EXTENSIONS, FORMAT_GROUPS, FORMAT_SUMMARY, parserForExtension, unsupportedFormatMessage } from '../../../shared/file-formats.js';

const { Dragger } = Upload;

const ACCEPT_EXT = ACCEPTED_EXTENSIONS;
const ACCEPT_ATTR = ACCEPT_EXT.join(',');
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_FILES = 60;

let uidSeed = 0;

function extOf(name) {
  const index = String(name || '').lastIndexOf('.');
  return index === -1 ? '' : String(name).slice(index).toLowerCase();
}

function fileIcon(name) {
  const ext = extOf(name);
  if (ext === '.pdf') return <FilePdfOutlined className="file-icon pdf" />;
  if (ext === '.zip') return <FileZipOutlined className="file-icon zip" />;
  const parser = parserForExtension(ext);
  if (['pptx', 'ppt', 'odp'].includes(parser)) return <FilePptOutlined className="file-icon ppt" />;
  if (['docx', 'doc', 'odt', 'rtf'].includes(parser)) return <FileWordOutlined className="file-icon" />;
  if (parser === 'spreadsheet') return <FileExcelOutlined className="file-icon" />;
  return <FileTextOutlined className="file-icon" />;
}

/**
 * 批量上传弹窗（拖拽区 + 多选 + 上传进度 + “已加入队列”反馈）。
 *
 * 交互说明：
 * - 拖拽 / 选择后文件先进入待上传列表，可逐个移除；点「上传」统一提交给
 *   POST /courses/:courseId/files（字段名 files），后端立即 202，因此反馈很快。
 * - 上传中禁用关闭，避免中断；成功后清空列表并在 1 秒内显示“已加入队列”。
 * - 底部小字展示 /api/health 的笔记引擎状态（AI 已配置 / 本地结构化模式）。
 */
export default function UploadModal({ open, courseId, onClose, onAccepted }) {
  const { message } = AntdApp.useApp();
  const [files, setFiles] = useState([]);
  const [phase, setPhase] = useState('idle'); // idle | uploading | done | error
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [health, setHealth] = useState(null);

  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    if (!open) return undefined;
    setFiles([]);
    filesRef.current = [];
    setPhase('idle');
    setProgress(0);
    setResult(null);
    setErrorMsg('');

    let alive = true;
    api
      .health()
      .then((data) => {
        if (alive) setHealth(data);
      })
      .catch(() => {
        if (alive) setHealth(null);
      });
    return () => {
      alive = false;
    };
  }, [open, courseId]);

  const addFiles = useCallback(
    (incoming) => {
      const prev = filesRef.current;
      const accepted = [];
      const warnings = [];

      for (const raw of incoming) {
        const name = raw?.name || '';
        const ext = extOf(name);
        if (!ACCEPT_EXT.includes(ext)) {
          warnings.push(`已忽略「${name}」：${unsupportedFormatMessage(name)}`);
          continue;
        }
        if (raw.size > MAX_FILE_SIZE) {
          warnings.push(`已忽略「${name}」：超过 100MB 上限`);
          continue;
        }
        if (prev.length + accepted.length >= MAX_FILES) {
          warnings.push(`一次最多上传 ${MAX_FILES} 个文件`);
          continue;
        }
        // 同名同大小视为重复拖入
        const duplicated =
          prev.some((item) => item.name === name && item.size === raw.size) ||
          accepted.some((item) => item.name === name && item.size === raw.size);
        if (duplicated) continue;
        uidSeed += 1;
        accepted.push({ uid: `upload-${uidSeed}`, file: raw, name, size: raw.size });
      }

      if (accepted.length > 0) {
        filesRef.current = [...prev, ...accepted];
        setFiles(filesRef.current);
      }
      warnings.forEach((text) => message.warning(text));
    },
    [message],
  );

  const removeFile = (uid) => {
    if (phase === 'uploading') return;
    filesRef.current = filesRef.current.filter((item) => item.uid !== uid);
    setFiles(filesRef.current);
  };

  const handleUpload = async () => {
    const pending = filesRef.current;
    if (pending.length === 0) return;
    setPhase('uploading');
    setProgress(0);
    setErrorMsg('');
    setResult(null);
    try {
      const data = await api.uploadFiles(
        courseId,
        pending.map((item) => item.file),
        { onProgress: (value) => setProgress(value) },
      );
      setProgress(1);
      setResult(data);
      setPhase('done');
      filesRef.current = [];
      setFiles([]);
      message.success(data?.message || `已加入队列，共 ${data?.accepted ?? pending.length} 个文件`);
      onAccepted?.(data);
    } catch (err) {
      setPhase('error');
      setErrorMsg(err?.message || '上传失败，请稍后重试');
    }
  };

  const totalSize = files.reduce((sum, item) => sum + (item.size || 0), 0);
  const uploading = phase === 'uploading';

  const footer = (
    <>
      {phase !== 'done' && (
        <>
          <span className="upload-footer-hint">
            {files.length > 0 ? `已选择 ${files.length} 个文件 · 待上传队列 · ${formatFileSize(totalSize)}` : '选择或拖入课件文件'}
          </span>
          <Button onClick={onClose} disabled={uploading}>
            取消
          </Button>
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            loading={uploading}
            disabled={files.length === 0}
            onClick={handleUpload}
          >
            {files.length > 0 ? `上传 ${files.length} 个文件` : '上传'}
          </Button>
        </>
      )}
      {phase === 'done' && (
        <Button type="primary" onClick={onClose}>
          完成
        </Button>
      )}
    </>
  );

  return (
    <Modal
      open={open}
      centered
      title="批量上传课件"
      className="upload-modal"
      width={640}
      onCancel={onClose}
      footer={footer}
      maskClosable={!uploading}
      keyboard={!uploading}
      closable={!uploading}
      destroyOnHidden
    >
      {phase === 'done' && result ? (
        <div className="upload-result">
          <Alert
            type="success"
            showIcon
            message={`已加入队列，共 ${result.accepted ?? 0} 个文件`}
            description="关闭弹窗后，页面底部的队列浮条会显示解析进度，完成后笔记列表自动刷新。"
          />
          {Array.isArray(result.skipped) && result.skipped.length > 0 && (
            <Alert
              className="upload-skipped"
              type="warning"
              showIcon
              message={`${result.skipped.length} 个文件被跳过`}
              description={
                <ul>
                  {result.skipped.map((item) => (
                    <li key={`${item.name}-${item.reason}`}>
                      {item.name}：{item.reason}
                    </li>
                  ))}
                </ul>
              }
            />
          )}
        </div>
      ) : (
        <>
          <p className="modal-intro">同一门课的资料可以一起上传，整理后自动归档为复习笔记。</p>
          <Dragger
            multiple
            accept={ACCEPT_ATTR}
            showUploadList={false}
            disabled={uploading}
            beforeUpload={(file) => {
              addFiles([file]);
              // 交给自定义列表管理，阻止 Upload 内部再走一遍上传流程
              return Upload.LIST_IGNORE;
            }}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">把课件拖到这里，或点击选择文件</p>
            <p className="ant-upload-hint">
              支持 {FORMAT_SUMMARY}。单文件 ≤ 100MB，一次最多 60 个，ZIP 内可混装文档。
            </p>
          </Dragger>

          <details className="upload-formats">
            <summary>查看支持的文件格式</summary>
            {FORMAT_GROUPS.map((group) => (
              <div key={group.label}><strong>{group.label}</strong><span>{group.extensions.join('、')}</span></div>
            ))}
            <p>WPS 专有格式请另存为 DOCX／PPTX／XLSX；RAR／7Z 请先解压。纯图片和扫描件不做 OCR。</p>
          </details>

          {files.length > 0 && (
            <div className="upload-file-list">
              {files.map((item) => (
                <div className="upload-file" key={item.uid}>
                  {fileIcon(item.name)}
                  <span className="upload-file-name" title={item.name}>
                    {item.name}
                  </span>
                  <span className="upload-file-size">{formatFileSize(item.size)}</span>
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={uploading}
                    onClick={() => removeFile(item.uid)}
                    aria-label={`移除 ${item.name}`}
                  />
                </div>
              ))}
            </div>
          )}

          {uploading && (
            <div className="upload-progress">
              <Progress percent={Math.round(progress * 100)} status="active" />
              <p className="upload-progress-note">正在上传，服务器接收后立即加入解析队列…</p>
            </div>
          )}

          {phase === 'error' && (
            <Alert className="upload-error" type="error" showIcon message="上传失败" description={errorMsg} />
          )}

          <div className="upload-health">
            {health?.ai
              ? health.ai.configured
                ? `笔记引擎：AI 已配置${health.ai.model ? ` · ${health.ai.model}` : ''}`
                : '笔记引擎：本地结构化模式（未配置 AI，笔记以大纲与要点为主）'
              : '上传后会在后台解析，可随时关闭页面，处理结果会保留。'}
          </div>
        </>
      )}
    </Modal>
  );
}
