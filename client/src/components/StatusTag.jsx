import { Tag } from 'antd';
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  LoadingOutlined,
} from '@ant-design/icons';

const META = {
  processing: { color: 'processing', label: '解析中', icon: <LoadingOutlined /> },
  queued: { color: 'default', label: '排队中', icon: <ClockCircleOutlined /> },
  done: { color: 'success', label: '已完成', icon: <CheckCircleFilled /> },
  failed: { color: 'error', label: '处理失败', icon: <CloseCircleFilled /> },
};

/** 笔记 / 队列状态标签（processing | done | failed） */
export default function StatusTag({ status, className }) {
  const meta = META[status] || { color: 'default', label: status || '未知', icon: null };
  return (
    <Tag color={meta.color} bordered={false} className={className} icon={meta.icon}>
      {meta.label}
    </Tag>
  );
}
