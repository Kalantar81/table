import { Component, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';

import { DataTable } from './data-table/data-table';
import { TableConfig } from './table-config';

interface Customer {
  id: number;
  name: string;
  country: string;
  company: string;
  status: string;
  balance: number;
  joined: string;
}

const ROW_COUNT = 50_000;

@Component({
  selector: 'app-table',
  standalone: true,
  imports: [DataTable],
  templateUrl: './table.html',
  styleUrl: './table.less',
})
export class Table {
  /** Table layout (columns, page sizes…) loaded at runtime from public/table.config.json. */
  readonly config = httpResource<TableConfig<Customer>>(() => 'table.config.json');

  readonly customers = signal<Customer[]>(generateCustomers(ROW_COUNT));

  trackById = (row: Customer) => row.id;
}

function generateCustomers(count: number): Customer[] {
  const firstNames = [
    'Amy', 'Anna', 'Asiya', 'Bernardo', 'Elwin', 'Ioni', 'Ivan', 'Onyama', 'Stephen', 'Xuxue',
    'Daniel', 'Florent', 'Olivia', 'James', 'Mason', 'Sophia', 'Liam', 'Emma', 'Noah', 'Lucas',
    'Mia', 'Ethan', 'Isabella', 'Logan', 'Ava', 'Henry', 'Charlotte', 'Sebastian', 'Amelia', 'Owen',
  ];
  const lastNames = [
    'Elsner', 'Fali', 'Javayant', 'Dominic', 'Sharvill', 'Bowcher', 'Magalhaes', 'Limba', 'Shaw',
    'Feng', 'Velasco', 'Vega', 'Brown', 'Smith', 'Wilson', 'Davis', 'Garcia', 'Martinez',
    'Rodriguez', 'Hernandez', 'Lopez', 'Gonzalez', 'Perez', 'Sanchez', 'Rivera',
  ];
  const countries = ['USA', 'Brazil', 'Germany', 'France', 'India', 'Spain', 'Japan', 'Canada'];
  const companies = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Stark Industries', 'Wayne Enterprises', 'Cyberdyne'];
  const statuses = ['qualified', 'unqualified', 'new', 'renewal', 'proposal'];

  const data: Customer[] = new Array(count);
  for (let i = 1; i <= count; i++) {
    const month = String((i * 7) % 12 + 1).padStart(2, '0');
    const day = String((i * 11) % 27 + 1).padStart(2, '0');
    data[i - 1] = {
      id: i,
      name: `${firstNames[i % firstNames.length]} ${lastNames[i % lastNames.length]}`,
      country: countries[i % countries.length],
      company: companies[i % companies.length],
      status: statuses[i % statuses.length],
      balance: Math.round((Math.sin(i) + 1.5) * 50000) / 10,
      joined: `2023-${month}-${day}`,
    };
  }
  return data;
}
