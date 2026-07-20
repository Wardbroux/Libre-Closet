import {
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
  type Ref,
} from '@mikro-orm/core';
import { User } from './user.entity';

@Entity()
@Unique({ properties: ['name', 'owner'] })
export class WardrobeLocation {
  @PrimaryKey()
  public id!: number;

  @Property()
  public name!: string;

  @ManyToOne({
    entity: () => User,
    deleteRule: 'cascade',
    ref: true,
    nullable: true,
  })
  public owner?: Ref<User>;
}
