import { Routes } from '@angular/router';

// Rutene er lazy per feature (IMPLEMENTERINGSPLAN 3.1). Kun oversikten finnes i skjelettet.
export const routes: Routes = [
  {
    path: '',
    title: 'Glimtpanel',
    loadComponent: () => import('@features/overview/overview.page').then((m) => m.OverviewPage),
  },
  { path: '**', redirectTo: '' },
];
