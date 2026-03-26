import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./Layout";
import Dashboard from "./Dashboard";
import AccountManagement from "./AccountManagement";
import UsageStat from "./UsageStat";
import UsageStats from "./UsageStats";
import ProxySettings from "./ProxySettings";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
        <Route path="/dashboard-api/dashboard" element={<Dashboard />} />
        <Route path="/dashboard-api/dashboard" element={<AccountManagement />} />
        <Route path="/dashboard-api/dashboard" element={<UsageStat />} />
        <Route path="/dashboard-api/dashboard" element={<UsageStats />} />
        <Route path="/dashboard-api/edit" element={<ProxySettings />} />
          <Route path="/" element={<Navigate to="/dashboard-api/dashboard" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
