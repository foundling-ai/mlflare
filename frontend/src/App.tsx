import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { getToken } from './lib/api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import RunDetail from './pages/RunDetail';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/runs/:id"
          element={
            <ProtectedRoute>
              <RunDetail />
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
