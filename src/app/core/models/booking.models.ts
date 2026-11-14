export type VehicleLayout = string;   // 'bus' | 'minibus16' | 'minibus10' ou un plan personnalisé

export interface SearchParams { from: string; to: string; date: string; passengers: number }

/** Un départ proposé à la vente (réponse de l'API de recherche). */
export interface TripSlot {
  tripId: string; routeId: string;
  busId: string; busName: string; busType: string;
  vehicleLayout: VehicleLayout; capacity: number;
  departure: string; arrival: string; arrivalDate?: string; duration: string; durationMin: number;
  departureAt: string; arrivalAt: string; serviceDate: string;
  price: number; seatsAvailable: number; amenities: string[];
  fromStation?: string | null; toStation?: string | null;
}
/** Départ choisi par le client (même forme que TripSlot, conservé sous ce nom pour les écrans existants). */
export interface Bus {
  id: string; tripId: string; name: string; type: string; vehicleLayout: VehicleLayout; capacity: number;
  departure: string; arrival: string; duration: string; price: number; seatsAvailable: number; amenities: string[];
  departureAt?: string;
}
export interface Passenger { firstName: string; lastName: string; phone: string; gender: string; seatNumber: string; category?: 'adult' | 'child' }
export interface PopularRoute { from: string; to: string; price: number }

export type RouteAvailability =
  | { status: 'available'; slots: TripSlot[] }
  | { status: 'no_vehicles'; reason: 'no_trips' | 'full'; message: string }
  | { status: 'suspended'; reason?: string; until?: string }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

export interface SeatRowDef { rowId: string; seats: string[]; isDriverRow?: boolean; aisleAfter?: number }
export interface SeatState { seat: string; status: 'held' | 'booked'; mine: boolean }
export interface HoldInfo { token: string; tripId: string; seats: string[]; expiresAt: string; extensionsLeft: number }

/** Réservation telle que renvoyée par l'API. */
export interface ApiPassenger { id: string; seatNo: string; firstName: string; lastName: string; phone: string | null; gender: string; category: string; price: number; status: string; ticketNumber: string | null; boardedAt: string | null }
export interface ApiBooking {
  id: string; reference: string; status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired' | 'completed' | 'no_show';
  channel: string; cancelReason: string | null; needsAttention: boolean; attentionNote?: string | null;
  createdAt: string; expiresAt: string | null; confirmedAt: string | null; cancelledAt: string | null;
  subtotal: number; serviceFee: number; taxAmount: number; total: number; currency: string;
  contact: { name: string; phone: string; email: string | null };
  trip: { tripId: string; fromCity: string; toCity: string; serviceDate: string; departureAt: string; arrivalAt: string; departure: string; arrival: string; duration: string; price: number;
    vehicleName: string; vehicleType: string; vehicleLayout: string; capacity: number; status: string; fromStation?: string | null; toStation?: string | null };
  tripStatus: string; plateNumber?: string;
  passengers: ApiPassenger[]; seats: string[];
  payment: { status: 'unpaid' | 'pending' | 'paid' | 'refund_pending' | 'partially_refunded' | 'refunded'; method: string | null; paidAmount: number; refundedAmount: number; refundPendingAmount: number; lastPaymentId: string | null; lastPaymentStatus: string | null };
  canCancel: boolean; canChange: boolean; cancelDeadline: string; refundPercent: number;
  accessToken?: string;
}
export interface ApiPayment { id: string; bookingId: string; method: string; simulated: boolean; amount: number; currency: string; status: 'initiated' | 'pending' | 'succeeded' | 'failed' | 'expired' | 'refund_pending' | 'refunded' | 'partially_refunded';
  failureReason: string | null; clientAction: { type: string; message?: string; url?: string } | null; createdAt: string }
export interface TicketQr { passengerId: string; ticketNumber: string; seatNo: string; name: string; qrDataUrl: string }
