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
  seatsAvailable: number;
  amenities: string[];
  rating: number;
}

export interface Passenger {
  firstName: string;
  lastName: string;
  age: number;
  gender: string;
  seatNumber: string;
}

export interface BookingState {
  searchParams: SearchParams | null;
  selectedBus: Bus | null;
  selectedSeats: string[];
  passengers: Passenger[];
  bookingReference: string;
}

export const POPULAR_ROUTES = [
  { from: 'Antananarivo', to: 'Toamasina', price: 25000 },
  { from: 'Antananarivo', to: 'Antsirabe', price: 12000 },
  { from: 'Antananarivo', to: 'Fianarantsoa', price: 18000 },
  { from: 'Toamasina', to: 'Maroantsetra', price: 30000 },
];

export const MOCK_BUSES: Bus[] = [
  {
    id: '1',
    name: 'Express Voyager',
    type: 'Sleeper',
    departure: '06:00 AM',
    arrival: '02:30 PM',
    duration: '8h 30m',
    price: 25000,
    seatsAvailable: 12,
    amenities: ['wifi', 'ac', 'recliner', 'charging'],
    rating: 4.5,
  },
  {
    id: '2',
    name: 'Premium Cruiser',
    type: 'Semi-Sleeper',
    departure: '08:30 AM',
    arrival: '04:15 PM',
    duration: '7h 45m',
    price: 30000,
    seatsAvailable: 8,
    amenities: ['wifi', 'ac', 'charging', 'entertainment'],
    rating: 4.7,
  },
  {
    id: '3',
    name: 'Budget Express',
    type: 'Seater',
    departure: '10:00 AM',
    arrival: '06:45 PM',
    duration: '8h 45m',
    price: 18000,
    seatsAvailable: 18,
    amenities: ['ac', 'charging'],
    rating: 4.2,
  },
  {
    id: '4',
    name: 'Luxury Liner',
    type: 'Sleeper',
    departure: '11:30 PM',
    arrival: '07:00 AM',
    duration: '7h 30m',
    price: 40000,
    seatsAvailable: 6,
    amenities: ['wifi', 'ac', 'recliner', 'charging', 'entertainment', 'blanket'],
    rating: 4.9,
  },
  {
    id: '5',
    name: 'City Shuttle',
    type: 'Seater',
    departure: '02:00 PM',
    arrival: '10:00 PM',
    duration: '8h 00m',
    price: 20000,
    seatsAvailable: 15,
    amenities: ['ac', 'wifi'],
    rating: 4.3,
  },
];
