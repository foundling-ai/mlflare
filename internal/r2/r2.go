package r2

import (
	"context"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/spf13/viper"
)

type Client struct {
	s3     *s3.Client
	bucket string
}

func NewClientFromConfig() (*Client, error) {
	accountID := viper.GetString("account_id")
	accessKeyID := viper.GetString("r2_access_key_id")
	secretAccessKey := viper.GetString("r2_secret_access_key")
	bucket := viper.GetString("r2_bucket")

	if accountID == "" || accessKeyID == "" || secretAccessKey == "" {
		return nil, fmt.Errorf("R2 credentials not configured (account_id, r2_access_key_id, r2_secret_access_key)")
	}
	if bucket == "" {
		bucket = "mlflare-storage"
	}

	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID)

	cfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, "")),
		awsconfig.WithRegion("auto"),
	)
	if err != nil {
		return nil, fmt.Errorf("loading AWS config: %w", err)
	}

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
	})

	return &Client{s3: s3Client, bucket: bucket}, nil
}

func (c *Client) Upload(ctx context.Context, key, filePath string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("opening file: %w", err)
	}
	defer f.Close()

	_, err = c.s3.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
		Body:   f,
	})
	if err != nil {
		return fmt.Errorf("uploading to R2: %w", err)
	}

	return nil
}

func (c *Client) Download(ctx context.Context, key, destPath string) error {
	result, err := c.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("downloading from R2: %w", err)
	}
	defer result.Body.Close()

	f, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = f.ReadFrom(result.Body)
	return err
}
