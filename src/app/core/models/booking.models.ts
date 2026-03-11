export type VehicleLayout = 'bus' | 'minibus16' | 'minibus10';

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
  vehicleLayout: VehicleLayout;
  capacity: number;
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
  { from: 'Antananarivo', to: 'Toamasina',    price: 35000 },
  { from: 'Antananarivo', to: 'Fianarantsoa', price: 28000 },
  { from: 'Antananarivo', to: 'Mahajanga',    price: 45000 },
  { from: 'Antananarivo', to: 'Toliara',      price: 55000 },
];

export const MOCK_BUSES: Bus[] = [
  // ── Grand bus (48 places) ──────────────────────────────────────────────────
  {
    id: '1',
    name: 'Express Côte Est',
    type: 'Bus Climatisé',
    vehicleLayout: 'bus',
    capacity: 48,
    departure: '06:00', arrival: '12:30', duration: '6h30',
    price: 35000, rating: 4.8, seatsAvailable: 18,
    amenities: ['ac', 'wifi', 'charging', 'recliner'],
  },
  {
    id: '2',
    name: 'Rapide Highlands',
    type: 'Bus Express',
    vehicleLayout: 'bus',
    capacity: 48,
    departure: '08:30', arrival: '14:00', duration: '5h30',
    price: 42000, rating: 4.6, seatsAvailable: 12,
    amenities: ['ac', 'wifi', 'entertainment', 'charging', 'recliner', 'blanket'],
  },
  {
    id: '3',
    name: 'Confort Panorama',
    type: 'Bus Standard',
    vehicleLayout: 'bus',
    capacity: 48,
    departure: '10:00', arrival: '17:30', duration: '7h30',
    price: 28000, rating: 4.3, seatsAvailable: 25,
    amenities: ['ac', 'recliner'],
  },
  {
    id: '4',
    name: 'Nuit Étoilée',
    type: 'Bus de Nuit',
    vehicleLayout: 'bus',
    capacity: 48,
    departure: '21:00', arrival: '05:30', duration: '8h30',
    price: 38000, rating: 4.5, seatsAvailable: 8,
    amenities: ['ac', 'blanket', 'recliner', 'charging'],
  },

  // ── Minibus 16 places ──────────────────────────────────────────────────────
  // Layout : 2 devant | rangée A=4 | rangées B,C=3 | rangée D=4
  {
    id: '5',
    name: 'Swift Highlands',
    type: 'Minibus 16 places',
    vehicleLayout: 'minibus16',
    capacity: 16,
    departure: '07:00', arrival: '12:00', duration: '5h00',
    price: 40000, rating: 4.7, seatsAvailable: 10,
    amenities: ['ac', 'wifi', 'charging'],
  },
  {
    id: '6',
    name: 'Côte Express Mini',
    type: 'Minibus 16 places',
    vehicleLayout: 'minibus16',
    capacity: 16,
    departure: '09:30', arrival: '15:00', duration: '5h30',
    price: 38000, rating: 4.4, seatsAvailable: 14,
    amenities: ['ac', 'recliner'],
  },

  // ── Minibus VIP 10 places ──────────────────────────────────────────────────
  // Layout : 2 devant | 4 rangées × 2 sièges (gauche + droite)
  {
    id: '7',
    name: 'VIP Prestige',
    type: 'Minibus VIP 10 places',
    vehicleLayout: 'minibus10',
    capacity: 10,
    departure: '07:30', arrival: '12:00', duration: '4h30',
    price: 75000, rating: 4.9, seatsAvailable: 6,
    amenities: ['ac', 'wifi', 'entertainment', 'charging', 'recliner', 'blanket'],
  },
  {
    id: '8',
    name: 'Elite Transfert',
    type: 'Minibus VIP 10 places',
    vehicleLayout: 'minibus10',
    capacity: 10,
    departure: '11:00', arrival: '16:00', duration: '5h00',
    price: 70000, rating: 4.8, seatsAvailable: 8,
    amenities: ['ac', 'wifi', 'charging', 'recliner'],
  },
];
