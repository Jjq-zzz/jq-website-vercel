import { useEffect, useState } from 'react';
import { Button, Input } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../hooks/useAuth.jsx';
import BrandMark from '../components/BrandMark.jsx';

/**
 * 昵称与密码登录，支持在同一页面创建账号。
 * 成功后 localStorage 保存用户及随机会话凭证，刷新保持登录。
 */
export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [register, setRegister] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const target = location.state?.from || '/';

  useEffect(() => {
    if (user) navigate(target, { replace: true });
  }, [user, target, navigate]);

  const submit = async () => {
    const nickname = name.trim();
    if (!nickname) {
      setError('请输入昵称或学号');
      return;
    }
    if (Array.from(nickname).length > 20) {
      setError('昵称最多 20 个字符');
      return;
    }
    if (password.length < 8 || password.length > 128) { setError('密码需为 8–128 个字符'); return; }
    if (register && password !== confirmation) { setError('两次输入的密码不一致'); return; }
    setSubmitting(true);
    setError('');
    try {
      await login(nickname, password, register);
      navigate(target, { replace: true });
    } catch (err) {
      setError(err?.message || '登录失败，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <BrandMark className="login-logo" />
          <h1 className="login-title">课研</h1>
          <p className="login-sub">整门课的课件，收进一本复习笔记。</p>
        </div>

        <label className="login-label" htmlFor="login-nickname">
          昵称或学号
        </label>
        <Input
          id="login-nickname"
          size="large"
          placeholder="比如：小林 / 20231001"
          maxLength={20}
          autoFocus
          allowClear
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (error) setError('');
          }}
          onPressEnter={submit}
          disabled={submitting}
          status={error ? 'error' : undefined}
        />
        <label className="login-label password-label" htmlFor="login-password">密码</label>
        <Input.Password id="login-password" size="large" placeholder="请输入 8–128 位密码"
          autoComplete={register ? 'new-password' : 'current-password'} maxLength={128}
          value={password} onChange={(event) => setPassword(event.target.value)}
          onPressEnter={submit} disabled={submitting} />
        {register && <>
          <label className="login-label password-label" htmlFor="login-confirmation">确认密码</label>
          <Input.Password id="login-confirmation" size="large" placeholder="再次输入密码" autoComplete="new-password"
            value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
            onPressEnter={submit} disabled={submitting} maxLength={128} />
        </>}
        {error && <div className="login-error" role="alert">{error}</div>}

        <Button
          type="primary"
          size="large"
          block
          loading={submitting}
          onClick={submit}
          className="login-submit"
        >
          {register ? '创建账号并进入' : '进入课研'}
        </Button>

        <Button type="text" block className="login-switch" disabled={submitting} onClick={() => {
          setRegister(!register); setError(''); setPassword(''); setConfirmation('');
        }}>{register ? '已有账号？返回登录' : '第一次使用？创建账号'}</Button>
        <p className="login-foot">请记住昵称和密码，用于访问你的课程和笔记。<br />旧版账号请由站点管理员先设置密码。</p>
      </div>
    </div>
  );
}
