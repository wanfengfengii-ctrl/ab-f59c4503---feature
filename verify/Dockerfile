# 一次性验收服务镜像：自带 Chromium 的 Playwright 官方镜像
FROM mcr.microsoft.com/playwright:v1.47.2-jammy
WORKDIR /e2e
# 浏览器二进制已随镜像提供，跳过 npm 安装时的重复下载
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --omit=dev || npm install --no-audit --no-fund --omit=dev
COPY run.mjs ./
CMD ["node", "run.mjs"]
