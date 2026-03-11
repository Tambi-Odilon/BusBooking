import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./layout/layout.component').then(m => m.LayoutComponent),
    children: [
      {
        path: '',
        loadComponent: () => import('./features/search/search.component').then(m => m.SearchComponent),
      },
      {
        path: 'buses',
        loadComponent: () => import('./features/bus-list/bus-list.component').then(m => m.BusListComponent),
      },
      {
        path: 'seats',
        loadComponent: () => import('./features/seat-selection/seat-selection.component').then(m => m.SeatSelectionComponent),
      },
      {
        path: 'passengers',
        loadComponent: () => import('./features/passenger-details/passenger-details.component').then(m => m.PassengerDetailsComponent),
      },
      {
        path: 'payment',
        loadComponent: () => import('./features/payment/payment.component').then(m => m.PaymentComponent),
      },
      {
        path: 'confirmation',
        loadComponent: () => import('./features/confirmation/confirmation.component').then(m => m.ConfirmationComponent),
      },
      {
        path: 'profile',
        loadComponent: () => import('./features/profile/profile.component').then(m => m.ProfileComponent),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
