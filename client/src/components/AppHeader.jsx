import { useState } from 'react';
import SettingsModal from './SettingsModal.jsx';
import { App as AntdApp, Avatar, Dropdown } from 'antd';
import { DownOutlined, LogoutOutlined, SwapOutlined, SettingOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../hooks/useAuth.jsx';
import { getInitial } from '../utils/format.js';
import BrandMark from './BrandMark.jsx';

/**
 * 应用顶栏：左侧品牌「课研」，右侧当前用户昵称菜单（切换用户 / 退出登录）。
 * 「切换用户」与「退出登录」都会清空本地登录态 —— 切换后需要重新输入昵称和密码。
 */
export default function AppHeader({ extra = null }) {
  const { user, logout } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();

  const items = [
    { key: 'settings', icon: <SettingOutlined />, label: 'AI Key 设置' },
    { key: 'switch', icon: <SwapOutlined />, label: '切换用户' },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
  ];

  const onMenuClick = ({ key }) => {
    if (key === 'settings') { setSettingsOpen(true); return; }
    if (key !== 'switch' && key !== 'logout') return;
    logout();
    message.success(key === 'switch' ? '已退出，请输入另一个昵称' : '已退出登录');
    navigate('/login', { replace: true });
  };

  return (
    <header className="app-header">
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <div className="app-header-inner">
        <Link to="/" className="brand" aria-label="课研首页">
          <BrandMark />
          <span className="brand-name">课研</span>
          <span className="brand-sub">课程笔记库</span>
        </Link>

        <div className="app-header-right">
          {extra}
          <Dropdown menu={{ items, onClick: onMenuClick }} trigger={['click']} placement="bottomRight">
            <button type="button" className="user-chip" aria-label="用户菜单" title={user?.aiKeyConfigured ? 'AI Key 已配置' : '未配置 AI Key'}>
              <Avatar
                size={24}
                style={{ background: 'var(--kys-surface-muted)', color: 'var(--kys-text)', fontSize: 12, fontWeight: 600 }}
              >
                {getInitial(user?.nickname)}
              </Avatar>
              <span className="user-chip-name">{user?.nickname || '未登录'}</span>
              <DownOutlined style={{ fontSize: 10, color: 'var(--kys-text-2)' }} />
            </button>
          </Dropdown>
        </div>
      </div>
    </header>
  );
}
