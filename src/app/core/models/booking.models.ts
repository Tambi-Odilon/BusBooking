export interface SearchParams {
  from: string;
  to: string;
  date: string;
  passengers: number;
}

export interface Bus {
  id: string;
  name: string;
  type: string;
  departure: string;
  arrival: string;
  duration: string;
  price: number;
  rating: number;
  seatsAvailable: number;
  amenities: string[];
}

export interface Passenger {
  firstName: string;
  lastName: string;
  age: number;
  gender: string;
  seatNumber: string;
}

export interface PopularRoute {
  from: string;
  to: string;
  price: number;
}

export const POPULAR_ROUTES: PopularRoute[] = [
  { from: 'Antananarivo', to: 'Toamasina', price: 35000 },
  { from: 'Antananarivo', to: 'Fianarantsoa', price: 28000 },
  { from: 'Antananarivo', to: 'Mahajanga', price: 45000 },
  { from: 'Antananarivo', to: 'Toliara', price: 55000 },
];

export const MOCK_BUSES: Bus[] = [
  {
    id: '1',
    name: 'Express Côte Est',
    type: 'Bus Climatisé',
    departure: '06:00',
    arrival: '12:30',
    duration: '6h30',
    price: 35000,
    rating: 4.8,
    seatsAvailable: 18,
    amenities: ['ac', 'wifi', 'charging', 'recliner'],
  },
  {
    id: '2',
    name: 'Rapide Highlands',
    type: 'Bus Express',
    departure: '08:30',
    arrival: '14:00',
    duration: '5h30',
    price: 42000,
    rating: 4.6,
    seatsAvailable: 12,
    amenities: ['ac', 'wifi', 'entertainment', 'charging', 'recliner', 'blanket'],
  },
  {
    id: '3',
    name: 'Confort Panorama',
    type: 'Bus Standard',
    departure: '10:00',
    arrival: '17:30',
    duration: '7h30',
    price: 28000,
    rating: 4.3,
    seatsAvailable: 25,
    amenities: ['ac', 'recliner'],
  },
  {
    id: '4',
    name: 'Nuit Étoilée',
    type: 'Bus de Nuit',
    departure: '21:00',
    arrival: '05:30',
    duration: '8h30',
    price: 38000,
    rating: 4.5,
    seatsAvailable: 8,
    amenities: ['ac', 'blanket', 'recliner', 'charging'],
  },
];
