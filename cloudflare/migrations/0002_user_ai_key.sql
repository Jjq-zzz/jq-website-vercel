-- 由 D1 迁移历史确保每个数据库只应用一次；旧用户默认未配置。
ALTER TABLE users ADD COLUMN ai_key_cipher TEXT;
ALTER TABLE users ADD COLUMN ai_key_iv TEXT;
ALTER TABLE users ADD COLUMN ai_base_url TEXT;
ALTER TABLE users ADD COLUMN ai_model TEXT;
