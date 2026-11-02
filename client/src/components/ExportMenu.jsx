import { Button, Dropdown } from 'antd';
import { DownOutlined, DownloadOutlined, FileMarkdownOutlined, FileZipOutlined } from '@ant-design/icons';

const ITEMS = [
  { key: 'md', icon: <FileMarkdownOutlined />, label: '合并为一个 .md 文件' },
  { key: 'zip', icon: <FileZipOutlined />, label: '打包为 .zip（每篇一个 .md）' },
];

/** 课程导出下拉：format=md / zip，下载走带 x-user-id 的 fetch + blob。 */
export default function ExportMenu({ onExport, loading = false, disabled = false }) {
  return (
    <Dropdown
      trigger={['click']}
      disabled={disabled}
      menu={{
        items: ITEMS,
        onClick: ({ key }) => onExport?.(key),
      }}
      placement="bottomRight"
    >
      <Button icon={<DownloadOutlined />} loading={loading} disabled={disabled}>
        课程导出 <DownOutlined style={{ fontSize: 10 }} />
      </Button>
    </Dropdown>
  );
}
