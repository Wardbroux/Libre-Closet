import { Migration } from '@mikro-orm/migrations';

export class Migration20260721030000 extends Migration {
  override async up(): Promise<void> {
    for (const name of ['Home', 'Storage locker', 'Laundry']) {
      this.addSql(
        `insert into "wardrobe_location" ("name", "owner_id") select '${name}', null where not exists (select 1 from "wardrobe_location" where "name" = '${name}' and "owner_id" is null);`,
      );
    }
  }
}
