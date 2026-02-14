package embedded

import "embed"

//go:embed worker/*
var WorkerAssets embed.FS

//go:embed pwa/*
var PWAAssets embed.FS

//go:embed migrations/*
var Migrations embed.FS
