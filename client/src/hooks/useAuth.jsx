import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, clearStoredUser, getStoredUser, storeUser } from '../api.js';

const AuthContext = createContext(null);

/**
 * 登录态：localStorage 保存 `{ id, nickname, token }`，刷新后保持。
 * 首次挂载若已有本地用户，静默调用 /auth/me 校验一次；401 会由 api 层清登录态并跳转。
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => getStoredUser());

  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    api
      .get('/auth/me')
      .then((data) => {
        if (!alive || !data || !data.user) return;
        storeUser(data.user);
        setUser(getStoredUser());
      })
      .catch(() => {
        // 后端不可用 / 用户已被清理时静默处理：有 user 但接口 401 时 api 层会跳转登录
      });
    return () => {
      alive = false;
    };
    // 只在首次挂载时校验；登录动作本身已经由登录接口确认过身份
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (nickname, password, register = false) => {
    const data = await api.post('/auth/login', { nickname, password, register });
    storeUser(data.user);
    setUser(getStoredUser());
    return data.user;
  }, []);

  const logout = useCallback(() => {
    api.post('/auth/logout').catch(() => {});
    clearStoredUser();
    setUser(null);
  }, []);

  const updateAiKeyConfigured = useCallback((configured) => {
    setUser((current) => {
      if (!current) return current;
      return storeUser({ ...current, aiKeyConfigured: configured });
    });
  }, []);

  const value = useMemo(
    () => ({ user, isAuthenticated: Boolean(user), login, logout, updateAiKeyConfigured }),
    [user, login, logout, updateAiKeyConfigured],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return context;
}
