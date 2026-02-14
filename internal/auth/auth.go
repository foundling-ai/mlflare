package auth

import (
	"crypto/rand"
	"encoding/base32"
	"fmt"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"github.com/mdp/qrterminal/v3"
	"os"
)

func GenerateTOTPSecret(issuer, account string) (*otp.Key, error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      issuer,
		AccountName: account,
	})
	if err != nil {
		return nil, fmt.Errorf("generating TOTP: %w", err)
	}
	return key, nil
}

func DisplayQRCode(key *otp.Key) {
	fmt.Printf("\nTOTP Secret: %s\n", key.Secret())
	fmt.Println("\nScan this QR code with your authenticator app:")
	qrterminal.GenerateHalfBlock(key.URL(), qrterminal.L, os.Stdout)
	fmt.Println()
}

func GenerateAPIToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b), nil
}

func ValidateTOTP(code, secret string) bool {
	return totp.Validate(code, secret)
}
