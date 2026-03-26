export const routes = [
  { path: "/dashboard-api/dashboard", component: "Dashboard", label: "Dashboard", screenType: "dashboard" },
  { path: "/dashboard-api/dashboard", component: "AccountManagement", label: "Account Management", screenType: "dashboard" },
  { path: "/dashboard-api/dashboard", component: "UsageStat", label: "Usage Stat", screenType: "dashboard" },
  { path: "/dashboard-api/dashboard", component: "UsageStats", label: "Usage Stats", screenType: "dashboard" },
  { path: "/dashboard-api/edit", component: "ProxySettings", label: "Proxy Settings", screenType: "edit" },
] as const;
