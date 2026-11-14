import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AdminSession } from '../../services/admin-session.service';
import { adminHome } from '../../guards/admin-auth.guard';

/** /admin : renvoie vers la première page que le rôle peut ouvrir. */
@Component({ selector: 'app-admin-home', standalone: true, template: '' })
export class AdminHomeComponent implements OnInit {
  private session = inject(AdminSession);
  private router = inject(Router);
  ngOnInit(): void { void this.router.navigateByUrl(adminHome(this.session, this.router)); }
}
