import { Routes } from '@angular/router';
import { authGuard, authShellMatch, devGuard, guestGuard } from '@core/guards';

/**
 * Ruter fra IMPLEMENTERINGSPLAN 3.1. Alt er lazy. Auth-sidene ligger under AuthShellComponent (sentrert, uten
 * navigasjon), innloggede sider under ShellComponent (sidepanel/bunnlinje). `/welcome` bruker hovedskallet uten
 * bunnlinje (`data.bottomNav`). /demo har eget skall (fase 10).
 */
export const routes: Routes = [
  {
    path: '',
    canMatch: [authShellMatch],
    loadComponent: () => import('./shell/auth-shell.component').then((m) => m.AuthShellComponent),
    children: [
      { path: 'login', canActivate: [guestGuard], loadComponent: () => import('@features/auth/login.page').then((m) => m.LoginPage) },
      { path: 'register', canActivate: [guestGuard], loadComponent: () => import('@features/auth/register.page').then((m) => m.RegisterPage) },
      { path: 'forgot', canActivate: [guestGuard], loadComponent: () => import('@features/auth/forgot.page').then((m) => m.ForgotPage) },
      { path: 'reset', loadComponent: () => import('@features/auth/reset.page').then((m) => m.ResetPage) },
      { path: 'confirm', loadComponent: () => import('@features/auth/confirm.page').then((m) => m.ConfirmPage) },
    ],
  },
  {
    path: 'demo',
    loadComponent: () => import('@features/demo/demo-shell.component').then((m) => m.DemoShell),
    children: [
      { path: '', loadComponent: () => import('@features/overview/overview.page').then((m) => m.OverviewPage) },
      { path: 'servers/:id', loadComponent: () => import('@features/server/server.page').then((m) => m.ServerPage) },
      { path: 'servers/:id/containers/:cid', loadComponent: () => import('@features/container/container.page').then((m) => m.ContainerPage) },
      { path: 'logs', loadComponent: () => import('@features/logs/logs.page').then((m) => m.LogsPage) },
    ],
  },
  { path: 'dev/components', canActivate: [devGuard], loadComponent: () => import('./dev/components.page').then((m) => m.ComponentsPage) },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell.component').then((m) => m.ShellComponent),
    children: [
      { path: '', loadComponent: () => import('@features/overview/overview.page').then((m) => m.OverviewPage) },
      { path: 'servers/:id', loadComponent: () => import('@features/server/server.page').then((m) => m.ServerPage) },
      { path: 'servers/:id/containers/:cid', loadComponent: () => import('@features/container/container.page').then((m) => m.ContainerPage) },
      { path: 'logs', loadComponent: () => import('@features/logs/logs.page').then((m) => m.LogsPage) },
      { path: 'alerts', loadComponent: () => import('@features/alerts/alerts.page').then((m) => m.AlertsPage) },
      { path: 'settings', redirectTo: 'settings/account', pathMatch: 'full' },
      { path: 'settings/:tab', loadComponent: () => import('@features/settings/settings.page').then((m) => m.SettingsPage) },
      { path: 'welcome', data: { bottomNav: false }, loadComponent: () => import('@features/pwa/welcome.page').then((m) => m.WelcomePage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
