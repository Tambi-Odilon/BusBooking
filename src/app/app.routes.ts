import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./components/layout/layout.component').then(m => m.LayoutComponent),
    children: [
      {
        path: '',
        loadComponent: () => import('./components/search/search.component').then(m => m.SearchComponent)
      },
      {
        path: 'buses',
        loadComponent: () => import('./components/bus-list/bus-list.component').then(m => m.BusListComponent)
      },
      {
        path: 'seats',
        loadComponent: () => import('./components/seat-selection/seat-selection.component').then(m => m.SeatSelectionComponent)
      },
      {
        path: 'passengers',
        loadComponent: () => import('./components/passenger-details/passenger-details.component').then(m => m.PassengerDetailsComponent)
      },
      {
        path: 'payment',
        loadComponent: () => import('./components/payment/payment.component').then(m => m.PaymentComponent)
      },
      {
        path: 'confirmation',
        loadComponent: () => import('./components/confirmation/confirmation.component').then(m => m.ConfirmationComponent)
      }
    ]
  },
  { path: '**', redirectTo: '' }
];
