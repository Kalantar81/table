import { Routes } from '@angular/router';

import { Table } from './table/table';

export const routes: Routes = [
  { path: '', component: Table },
  { path: '**', redirectTo: '' },
];
