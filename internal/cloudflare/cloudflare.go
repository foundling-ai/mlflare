package cloudflare

import (
	"context"
	"fmt"

	cf "github.com/cloudflare/cloudflare-go"
)

type Manager struct {
	api       *cf.API
	accountID string
}

func NewManager(apiToken, accountID string) (*Manager, error) {
	api, err := cf.NewWithAPIToken(apiToken)
	if err != nil {
		return nil, fmt.Errorf("creating Cloudflare client: %w", err)
	}
	return &Manager{api: api, accountID: accountID}, nil
}

func (m *Manager) CreateR2Bucket(ctx context.Context, name string) error {
	_, err := m.api.CreateR2Bucket(ctx, cf.AccountIdentifier(m.accountID), cf.CreateR2BucketParameters{
		Name: name,
	})
	if err != nil {
		return fmt.Errorf("creating R2 bucket: %w", err)
	}
	return nil
}

func (m *Manager) CreateD1Database(ctx context.Context, name string) (string, error) {
	db, err := m.api.CreateD1Database(ctx, cf.AccountIdentifier(m.accountID), cf.CreateD1DatabaseParams{
		Name: name,
	})
	if err != nil {
		return "", fmt.Errorf("creating D1 database: %w", err)
	}
	return db.UUID, nil
}
