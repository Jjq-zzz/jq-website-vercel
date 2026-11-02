import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';

import 'antd/dist/reset.css';
// highlight.js 浅色主题（github），配合 Markdown 代码块使用
import 'highlight.js/styles/github.css';
import './styles/global.css';

import App from './App.jsx';
import { AuthProvider } from './hooks/useAuth.jsx';
import themeConfig from './theme.js';

const rootElement = document.getElementById('root');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      <AntdApp>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
