# 仅打包源码，不读取个人配置或运行数据。
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
target = root / 'release' / 'cloudflare-github.zip'
target.parent.mkdir(exist_ok=True)
folders = ['client', 'cloudflare', 'serverless', 'shared', 'server', 'scripts', 'tests', 'vercel', 'api']
files = ['package.json', 'package-lock.json', 'wrangler.jsonc', 'README.md', '.gitignore', '.dockerignore',
         '.github/workflows/cloudflare.yml', 'docs/cloudflare-deployment.md', 'docs/api-contract.md']
extensions = {'.js', '.mjs', '.jsx', '.css', '.html', '.sql', '.json', '.jsonc', '.py'}
for folder in folders:
    for path in (root / folder).rglob('*'):
        relative = path.relative_to(root)
        if path.is_file() and not any(part in {'private', 'node_modules', 'data', '.downloads', 'fixtures', '__pycache__'} or part.startswith('.tmp') for part in relative.parts):
            if path.suffix in extensions or path.name == 'Dockerfile':
                files.append(relative.as_posix())
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for name in sorted(set(files)):
        archive.write(root / name, name)
    names = archive.namelist()
    assert 'cloudflare/migrations/0002_user_ai_key.sql' in names
    assert not any(Path(name).name.startswith('.env') or '.db' in Path(name).suffix for name in names)
print('已生成 Cloudflare GitHub 源码包，文件数：', len(names))
