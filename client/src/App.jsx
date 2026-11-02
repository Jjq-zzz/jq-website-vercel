import { Navigate, Route, Routes } from 'react-router-dom';

import LoginPage from './pages/LoginPage.jsx';
import CoursesPage from './pages/CoursesPage.jsx';
import CoursePage from './pages/CoursePage.jsx';
import NotePage from './pages/NotePage.jsx';
import RequireAuth from './components/RequireAuth.jsx';

/**
 * 路由表
 * /login                                    极简登录
 * /                                         课程列表
 * /courses/:courseId                        课程详情（笔记列表 + 队列）
 * /courses/:courseId/notes/:noteId?q=&hit=  笔记阅读（支持搜索命中高亮）
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<CoursesPage />} />
        <Route path="/courses/:courseId" element={<CoursePage />} />
        <Route path="/courses/:courseId/notes/:noteId" element={<NotePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
