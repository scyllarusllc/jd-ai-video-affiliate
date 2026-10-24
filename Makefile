.DEFAULT_GOAL := help

.PHONY: help install dev server web

help:
	@printf '%s\n' 'make install     安装前端依赖' 'make dev         启动 Tauri 与 Vite 开发环境' 'make server      make dev 的别名' 'make web         仅启动 Vite 前端服务'

install:
	cd desktop && npm ci

dev:
	cd desktop && PATH="$$PATH:$$HOME/.cargo/bin" npm run desktop

# Both goals share one recipe, so `make dev server` starts only one instance.
server: dev

web:
	cd desktop && npm run dev
