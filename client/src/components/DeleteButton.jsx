import { useState } from 'react';
import { App as AntdApp, Button, Popconfirm } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';

/** 删除需二次确认；接口成功后再移除页面内容，失败时保留当前状态。 */
export default function DeleteButton({ title, description, onDelete, label = '删除', ariaLabel, size = 'small', type = 'text' }) {
  const { message } = AntdApp.useApp();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    try {
      await onDelete();
      setOpen(false);
    } catch (err) {
      message.error(err?.message || '删除失败，请稍后重试');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <span className="delete-action" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <Popconfirm
        title={title}
        description={description}
        open={open}
        onOpenChange={(value) => { if (!deleting) setOpen(value); }}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: deleting }}
        cancelButtonProps={{ disabled: deleting }}
      >
        <Button danger type={type} size={size} icon={<DeleteOutlined />} loading={deleting} aria-label={ariaLabel || label}>
          {label}
        </Button>
      </Popconfirm>
    </span>
  );
}
