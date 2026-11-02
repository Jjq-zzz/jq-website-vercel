import { useEffect, useState } from 'react';
import { App, Alert, Button, Form, Input, Modal, Spin } from 'antd';
import { api } from '../api.js';
import { useAuth } from '../hooks/useAuth.jsx';

export default function SettingsModal({ open, onClose }) {
  const [form] = Form.useForm();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { message, modal } = App.useApp();
  const { updateAiKeyConfigured } = useAuth();
  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setLoading(true);
    setSettings(null);
    form.resetFields();
    api.getAiSettings().then((data) => {
      if (!active) return;
      setSettings(data);
      form.setFieldsValue({ apiKey: '', baseUrl: data.baseUrl || '', model: data.model || '' });
      updateAiKeyConfigured(data.configured);
    }).catch((error) => { if (active) message.error(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; form.resetFields(); };
  }, [open, form, message, updateAiKeyConfigured]);

  async function save(clear = false) {
    try {
      const values = clear ? form.getFieldsValue() : await form.validateFields();
      setSaving(true);
      const data = await api.saveAiSettings({ apiKey: clear ? '' : values.apiKey || '',
        baseUrl: values.baseUrl?.trim() || null, model: values.model?.trim() || null });
      updateAiKeyConfigured(data.configured);
      form.resetFields();
      message.success(data.configured ? '密钥已加密保存' : '密钥已清除');
      onClose();
    } catch (error) {
      if (error.errorFields) return;
      message.error(error.status === 503 ? '管理员尚未正确配置加密主密钥，请联系管理员：' + error.message : error.message);
    } finally { setSaving(false); }
  }
  return <Modal title="AI Key 设置" open={open} onCancel={saving ? undefined : onClose}
    maskClosable={!saving} closable={!saving} destroyOnClose
    footer={[
      <Button key="clear" danger disabled={loading || saving || !settings?.configured} onClick={() => modal.confirm({
        title: '确认清除 API Key？', content: '清除后将使用全局兜底配置；没有全局密钥时使用本地模式。',
        okText: '清除', cancelText: '取消', onOk: () => save(true),
      })}>清除密钥</Button>,
      <Button key="cancel" disabled={saving} onClick={onClose}>取消</Button>,
      <Button key="save" type="primary" loading={saving} disabled={loading || !settings} onClick={() => save()}>保存</Button>,
    ]}>
    <Spin spinning={loading}>
      {settings && <Alert type="info" showIcon style={{ marginBottom: 16 }} message={settings.configured
        ? '已配置：' + settings.masked + '；保存将覆盖；留空提交表示清除'
        : '当前为本地模式，不调用外部模型'} />}
      <Form form={form} layout="vertical" disabled={loading || saving || !settings} preserve={false}>
        <Form.Item name="apiKey" label="API Key" rules={[{ validator: (_, value) => !value?.trim() || (value.trim().length >= 8 && value.trim().length <= 200)
          ? Promise.resolve() : Promise.reject(new Error('密钥长度需为 8–200 个字符')) }]}>
          <Input.Password allowClear autoComplete="new-password" placeholder="填写自己的 API Key" />
        </Form.Item>
        <Form.Item name="baseUrl" label="Base URL（可选）" rules={[{ validator: (_, value) => !value?.trim() || /^https?:\/\//.test(value.trim())
          ? Promise.resolve() : Promise.reject(new Error('地址必须以 http:// 或 https:// 开头')) }]}>
          <Input placeholder="https://api.deepseek.com/v1" />
        </Form.Item>
        <Form.Item name="model" label="模型名（可选）" rules={[{ max: 64, message: '模型名不得超过 64 个字符' }]}>
          <Input placeholder="deepseek-flash" />
        </Form.Item>
      </Form>
    </Spin>
  </Modal>;
}
