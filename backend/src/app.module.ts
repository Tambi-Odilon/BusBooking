import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Db } from './common/db';
import { RateLimiter, RedisService } from './common/redis';
import { EventBus } from './common/events';
import { Audit } from './common/audit';
import { Idempotency } from './common/idempotency';
import { AuthGuard, AuthLoader } from './common/auth';
import { AllExceptionsFilter } from './common/errors';
import { SettingsService } from './modules/settings/settings.service';
import { FilesService, PublicController, SettingsController, SetupController } from './modules/settings/settings.controller';
import { AuthService } from './modules/auth/auth.service';
import { AuthController } from './modules/auth/auth.controller';
import { CustomersController, RolesController, StaffController } from './modules/auth/people.controller';
import { TripsService } from './modules/transport/trips.service';
import { DriversController, ReferenceController, RoutesController, TemplatesController, TripsAdminController, VehiclesController } from './modules/transport/transport.controller';
import { SeatsService } from './modules/booking/seats.service';
import { BookingsService } from './modules/booking/bookings.service';
import { BookingsController, SearchController, TicketsController } from './modules/booking/booking.controller';
import { RefundsService } from './modules/payments/refunds.service';
import { PaymentsService } from './modules/payments/payments.service';
import { PaymentsController, RefundsAdminController } from './modules/payments/payments.controller';
import { TicketsService } from './modules/tickets/tickets.service';
import { Outbox } from './modules/notifications/outbox';
import { NotificationsService } from './modules/notifications/notifications.service';
import { AdsController, AuditController, BookingsAdminController, ReportsController } from './modules/admin/admin.controller';
import { RealtimeGateway } from './modules/realtime/realtime.gateway';
import { Scheduler } from './modules/jobs/scheduler';
import { HealthController } from './modules/health/health.controller';

@Module({
  controllers: [
    HealthController, PublicController, SetupController, AuthController, SearchController, BookingsController, PaymentsController, TicketsController,
    // les routes à chemin fixe (trip-templates/reorder, trips/generate) sont déclarées avant les routes paramétrées
    TemplatesController, TripsAdminController, BookingsAdminController, ReportsController, AuditController, AdsController,
    RolesController, StaffController, CustomersController, ReferenceController, VehiclesController, DriversController, RoutesController,
    RefundsAdminController, SettingsController,
  ],
  providers: [
    Db, RedisService, RateLimiter, EventBus, Audit, Idempotency, AuthLoader,
    SettingsService, FilesService, AuthService, TripsService, SeatsService, BookingsService, RefundsService, PaymentsService, TicketsService,
    Outbox, NotificationsService, RealtimeGateway, Scheduler,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
