import { useEffect, useState } from 'react';
import { Alert, Form, Input, Modal } from 'antd';

import { api } from '../api.js';

/**
 * 新建课程弹窗：只有一个课程名字段，Enter / 点击「创建」都能提交。
 * 重名由后端返回 409 DUPLICATE_COURSE，这里给中文友好提示。
 */
export default function NewCourseModal({ open, onClose, onCreated }) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setError('');
  }, [open, form]);

  const handleFinish = async (values) => {
    const name = String(values.name || '').trim();
    if (!name) return;
    setSubmitting(true);
    setError('');
    try {
      const data = await api.post('/courses', { name });
      onCreated?.(data.course);
    } catch (err) {
      setError(
        err?.code === 'DUPLICATE_COURSE'
          ? '这个课程名已经用过了，换一个吧'
          : err?.message || '创建失败，请稍后再试',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      centered
      title="新建课程"
      className="new-course-modal"
      okText="创建"
      cancelText="取消"
      onOk={() => form.submit()}
      onCancel={onClose}
      confirmLoading={submitting}
      destroyOnHidden
      width={480}
      maskClosable={!submitting}
    >
      <p className="modal-intro">用课程名建一个归档位置，之后的课件和笔记都会收在这里。</p>
      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        onValuesChange={() => error && setError('')}
        requiredMark={false}
        preserve={false}
      >
        <Form.Item
          name="name"
          label="课程名"
          rules={[
            { required: true, whitespace: true, message: '请输入课程名' },
            { max: 40, message: '课程名最多 40 个字符' },
          ]}
          extra="例如：预防医学、数据结构（最多 40 个字符）"
        >
          <Input
            placeholder="课程名"
            maxLength={40}
            showCount
            autoFocus
            onPressEnter={() => form.submit()}
          />
        </Form.Item>
      </Form>
      {error && <Alert type="error" showIcon message={error} />}
    </Modal>
  );
}
