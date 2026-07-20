import { Migration } from '@mikro-orm/migrations';

export class Migration20260721020000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'create table "wardrobe_location" ("id" serial primary key, "name" text not null, "owner_id" int null);',
    );
    this.addSql(
      'alter table "wardrobe_location" add constraint "wardrobe_location_owner_id_foreign" foreign key ("owner_id") references "user" ("id") on update cascade on delete cascade;',
    );
    this.addSql(
      'create unique index "wardrobe_location_name_owner_id_unique" on "wardrobe_location" ("name", "owner_id");',
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "wardrobe_location" cascade;');
  }
}
