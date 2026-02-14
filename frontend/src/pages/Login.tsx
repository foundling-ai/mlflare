import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { setToken } from '../lib/api';

export default function Login() {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (value: string) => {
    if (value.length !== 6) return;
    setLoading(true);
    setError('');

    try {
      const resp = await fetch('/auth/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: value }),
      });

      if (!resp.ok) {
        setError('Invalid code');
        setCode('');
        setLoading(false);
        return;
      }

      const data = await resp.json();
      setToken(data.token);
      navigate('/');
    } catch {
      setError('Connection failed');
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(value);
    if (value.length === 6) {
      handleSubmit(value);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="w-full max-w-sm p-8">
        <h1 className="text-3xl font-bold text-white text-center mb-2">MLflare</h1>
        <p className="text-gray-400 text-center mb-8">Enter your authenticator code</p>

        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={handleChange}
          placeholder="000000"
          disabled={loading}
          className="w-full text-center text-3xl tracking-[0.5em] bg-gray-900 border border-gray-700 rounded-lg px-4 py-4 text-white placeholder-gray-600 focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500 disabled:opacity-50"
        />

        {error && (
          <p className="text-red-400 text-center mt-4">{error}</p>
        )}

        {loading && (
          <p className="text-gray-400 text-center mt-4">Verifying...</p>
        )}
      </div>
    </div>
  );
}
