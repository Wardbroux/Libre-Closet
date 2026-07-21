import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Render,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { Payload } from '../auth/dto/payload.dto';
import {
  DEFAULT_CATEGORY_PATHS,
  SIZE_GROUPS,
  TOP_LEVEL_CATEGORIES,
} from './garment-category.enum';
import { GarmentColor } from './garment-color.enum';
import { GarmentService } from './garment.service';
import { WardrobeShareService } from '../wardrobe-share/wardrobe-share.service';
import { SharePermission } from '../dal/entity/wardrobe-share.entity';
import { PinLockService } from '../pin-lock/pin-lock.service';
import type { SearchGarmentDto } from './dto/search-garment.dto';
import type { FastifyReply, FastifyRequest } from 'fastify';

type CategoryOption = {
  label: string;
  value: string;
  href: string;
  hasChildren: boolean;
};

type CategoryTreeNode = {
  label: string;
  value: string;
  children: CategoryTreeNode[];
};

@UseGuards(ConditionalAuthGuard)
@Controller('wardrobe')
export class WardrobeController {
  private readonly logger = new Logger(WardrobeController.name);

  constructor(
    private readonly garmentService: GarmentService,
    private readonly shareService: WardrobeShareService,
    private readonly pinLockService: PinLockService,
  ) {}

  private userId(req: any): number | undefined {
    return (req['user'] as Payload | undefined)?.userId;
  }

  @Get()
  @Render('wardrobe/index')
  async index(
    @Req() req: FastifyRequest,
    @Query() query: SearchGarmentDto,
    @Query('ownerId') ownerId: string | undefined,
    @I18n() i18n: I18nContext,
  ) {
    const userId = this.userId(req);
    let viewOwner: number | undefined;
    let sharedWardrobes: any[] = [];
    let canEdit = true;

    if (userId != null) {
      sharedWardrobes = await this.shareService.getInboundShares(userId);
      sharedWardrobes = sharedWardrobes.map((s) => ({
        id: s.id,
        grantorId: s.grantor.unwrap().id,
        grantorName: s.grantor.unwrap().firstName || s.grantor.unwrap().email,
        permission: s.permission,
      }));
    }

    if (ownerId && userId != null) {
      viewOwner = parseInt(ownerId, 10);
      if (viewOwner === userId) {
        viewOwner = undefined;
      } else {
        const canView = await this.shareService.canView(userId, viewOwner);
        if (!canView) throw new ForbiddenException();
        const perm = await this.shareService.getSharePermission(
          userId,
          viewOwner,
        );
        canEdit = perm === SharePermission.MANAGE;
      }
    }

    const [garments, filters] = await Promise.all([
      this.garmentService.findAll(userId, query, viewOwner),
      this.garmentService.findAvailableFilters(viewOwner ?? userId),
    ]);
    const garmentCards = garments.map((garment) =>
      Object.assign(garment, {
        galleryPhotos: this.galleryPhotos(garment),
      }),
    );
    const availableCategories = filters.categories.map((value) => ({
      value,
      label: this.garmentService.resolveCategoryLabel(value, i18n),
    }));
    const categoryPanel = this.categoryPanel(
      filters.categories,
      query,
      viewOwner,
    );
    return {
      garments: garmentCards,
      availableCategories,
      categoryGroups: this.categoryGroups(filters.categories),
      categoryPanel,
      categoryShortcuts: categoryPanel.options,
      filterChips: this.filterChips(query, viewOwner),
      activeCategory: query.category || 'All',
      categoryTabs: TOP_LEVEL_CATEGORIES.map((category) => ({
        label: category,
        active: this.categoryTabActive(query.category, category),
        href: this.wardrobeUrl(
          query,
          {
            category: category === 'All' ? undefined : category,
          },
          viewOwner,
        ),
      })),
      colors: Object.values(GarmentColor),
      sizeGroups: SIZE_GROUPS,
      dashboardSizeGroups: this.sizeFilterGroups(query, viewOwner),
      sizeNoneHref: this.wardrobeUrl(query, { size: undefined }, viewOwner),
      availableSizes: filters.sizes,
      availableLocations: filters.locations,
      allLocationsHref: this.wardrobeUrl(
        query,
        { location: undefined },
        viewOwner,
      ),
      locationTabs: filters.locations.map((location) => ({
        label: location,
        active: location === query.location,
        href: this.wardrobeUrl(query, { location }, viewOwner),
      })),
      availableTags: filters.tags,
      search: query,
      sharedWardrobes,
      viewOwner: viewOwner ?? null,
      canEdit,
    };
  }

  @Get('new')
  @Render('wardrobe/form')
  async newForm(
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;
    if (userId != null && viewOwner != null && viewOwner !== userId) {
      const canManage = await this.shareService.canManage(userId, viewOwner);
      if (!canManage) throw new ForbiddenException();
    }
    const filters = await this.garmentService.findAvailableFilters(
      viewOwner ?? userId,
    );
    const categories = filters.categories.map((value) => ({
      value,
      label: this.garmentService.resolveCategoryLabel(value, i18n),
    }));
    return {
      categories,
      colors: Object.values(GarmentColor),
      garment: null,
      viewOwner,
      categoryGroups: this.categoryGroups(filters.categories),
      categoryTree: this.editCategoryTree(filters.categories),
      availableLocations: filters.locations,
      availableTags: filters.tags,
      sizeGroups: this.editSizeGroups(),
    };
  }

  @Post()
  async create(
    @Body()
    body: {
      name?: string;
      category: string;
      brand?: string;
      color?: string | string[];
      size?: string;
      location?: string;
      tags?: string;
      notes?: string;
      washingDetails?: string;
      dateAquired?: string;
    },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;

    if (userId != null && viewOwner != null && viewOwner !== userId) {
      const canManage = await this.shareService.canManage(userId, viewOwner);
      if (!canManage) throw new ForbiddenException();
    }

    // Fastify gives string if one checkbox, string[] if multiple — normalise both
    const contentType = req.headers['content-type'] ?? '';
    if (contentType.includes('multipart/form-data')) {
      const fields: Record<string, string> = {};
      const files = (async function* () {
        for await (const part of (req as any).parts()) {
          if (part.type === 'file') {
            yield part;
          } else {
            fields[part.fieldname] = String(part.value ?? '');
          }
        }
      })();
      const garment = await this.garmentService.create(
        {
          files,
          get name() {
            return fields.name;
          },
          get category() {
            return fields.category;
          },
          get brand() {
            return fields.brand;
          },
          get color() {
            return fields.color;
          },
          get size() {
            return fields.size;
          },
          get location() {
            return fields.location;
          },
          get tags() {
            return fields.tags;
          },
          get notes() {
            return fields.notes;
          },
          get washingDetails() {
            return fields.washingDetails;
          },
          get dateAquired() {
            return fields.dateAquired;
          },
        },
        viewOwner ?? userId,
      );

      const redirectSuffix = viewOwner ? `?ownerId=${viewOwner}` : '';
      return reply.redirect(`/wardrobe/${garment.id}${redirectSuffix}`, 302);
    }

    const rawColors = Array.isArray(body.color)
      ? body.color
      : (body.color
          ?.split(',')
          .map((c) => c.trim())
          .filter(Boolean) ?? []);

    const garment = await this.garmentService.create(
      {
        name: body.name,
        category: body.category,
        brand: body.brand,
        color: rawColors.join(','),
        size: body.size,
        location: body.location,
        tags: body.tags,
        notes: body.notes,
        washingDetails: body.washingDetails,
        dateAquired: body.dateAquired,
      },
      viewOwner ?? userId,
    );

    const redirectSuffix = viewOwner ? `?ownerId=${viewOwner}` : '';
    return reply.redirect(`/wardrobe/${garment.id}${redirectSuffix}`, 302);
  }

  @Get('settings')
  @Render('wardrobe/settings')
  async settings(@Req() req: FastifyRequest) {
    const userId = this.userId(req);
    const filters = await this.garmentService.findAvailableFilters(userId);
    return {
      locations: filters.locations,
      pinConfigured: await this.pinLockService.isConfigured(),
    };
  }

  @Post('settings/pin')
  async updatePin(
    @Body() body: { currentPin?: string; newPin?: string; confirmPin?: string },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const userId = this.userId(req);
    const pinConfigured = await this.pinLockService.isConfigured();
    const currentPin = String(body.currentPin ?? '').trim();
    const newPin = String(body.newPin ?? '').trim();
    const confirmPin = String(body.confirmPin ?? '').trim();

    const renderSettings = async (pinError: string) => {
      const filters = await this.garmentService.findAvailableFilters(userId);
      return reply.view('wardrobe/settings', {
        layout: 'layout',
        locations: filters.locations,
        pinConfigured,
        pinError,
        ...((reply as any).locals ?? {}),
      });
    };

    if (!/^\d{4,8}$/.test(newPin)) {
      return renderSettings('PIN must be 4 to 8 numbers.');
    }
    if (newPin !== confirmPin) {
      return renderSettings('New PINs do not match.');
    }
    if (pinConfigured && !(await this.pinLockService.verifyPin(currentPin))) {
      return renderSettings('Current PIN is incorrect.');
    }

    await this.pinLockService.setPin(newPin);
    reply.setCookie(
      'wardrobe_pin_unlock',
      await this.pinLockService.unlockToken(),
      {
        path: '/',
        maxAge: 30 * 24 * 60 * 60,
        httpOnly: true,
        sameSite: 'lax',
      },
    );
    return reply.redirect('/wardrobe/settings', 302);
  }

  @Post('settings/locations')
  async createLocation(
    @Body() body: { name?: string },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.garmentService.createLocation(body.name ?? '', this.userId(req));
    return reply.redirect('/wardrobe/settings', 302);
  }

  @Post('settings/locations/delete')
  async deleteLocation(
    @Body() body: { name?: string },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.garmentService.removeLocation(body.name ?? '', this.userId(req));
    return reply.redirect('/wardrobe/settings', 302);
  }

  @Get(':id')
  @Render('wardrobe/show')
  async show(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;
    const [garment, filters] = await Promise.all([
      this.garmentService.findOne(id, userId, viewOwner),
      this.garmentService.findAvailableFilters(viewOwner ?? userId),
    ]);
    const categories = filters.categories.map((value) => ({
      value,
      label: this.garmentService.resolveCategoryLabel(value, i18n),
    }));

    let canEdit = true;
    let canDelete = true;
    let canClone = true;
    if (userId != null && viewOwner != null && viewOwner !== userId) {
      const perm = await this.shareService.getSharePermission(
        userId,
        viewOwner,
      );
      canEdit = perm === SharePermission.MANAGE;
      canClone = perm === SharePermission.MANAGE;
      canDelete = false;
    } else if (userId != null && garment.owner?.id !== userId) {
      canEdit = false;
      canDelete = false;
      canClone = false;
    }

    return {
      garment,
      galleryPhotos: this.galleryPhotos(garment),
      categoryLabel: this.garmentService.resolveCategoryLabel(
        garment.category,
        i18n,
      ),
      canEdit,
      canDelete,
      canClone,
      viewOwner: viewOwner ?? null,
      categories,
      categoryGroups: this.categoryGroups(filters.categories),
      categoryPaths: this.categoryPaths(filters.categories),
      categoryTree: this.editCategoryTree(filters.categories),
      availableLocations: filters.locations,
      availableTags: filters.tags,
      colors: Object.values(GarmentColor),
      sizeGroups: this.editSizeGroups(),
    };
  }

  @Get(':id/edit')
  @Render('wardrobe/form')
  async editForm(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;

    if (userId != null && viewOwner != null && viewOwner !== userId) {
      const canManage = await this.shareService.canManage(userId, viewOwner);
      if (!canManage) throw new ForbiddenException();
    }

    const [garment, filters] = await Promise.all([
      this.garmentService.findOne(id, userId, viewOwner),
      this.garmentService.findAvailableFilters(viewOwner ?? userId),
    ]);
    const categories = filters.categories.map((value) => ({
      value,
      label: this.garmentService.resolveCategoryLabel(value, i18n),
    }));
    const colorEnumValues = Object.values(GarmentColor) as string[];
    const savedColors =
      garment.color
        ?.split(',')
        .map((c) => c.trim())
        .filter(Boolean) ?? [];
    const customColors = savedColors.filter(
      (c) => !colorEnumValues.includes(c),
    );

    return {
      garment,
      categories,
      colors: colorEnumValues,
      customColors,
      viewOwner: viewOwner ?? null,
      categoryGroups: this.categoryGroups(filters.categories),
      categoryTree: this.editCategoryTree(filters.categories),
      availableLocations: filters.locations,
      availableTags: filters.tags,
      sizeGroups: this.editSizeGroups(),
    };
  }

  @Get(':id/clone')
  @Render('wardrobe/form')
  async cloneForm(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;
    const [garment, filters] = await Promise.all([
      this.garmentService.findOne(id, userId, viewOwner),
      this.garmentService.findAvailableFilters(viewOwner ?? userId),
    ]);
    const categories = filters.categories.map((value) => ({
      value,
      label: this.garmentService.resolveCategoryLabel(value, i18n),
    }));
    return {
      garment,
      isClone: true,
      cloneName: garment.name ? `${garment.name} (cloned)` : undefined,
      categories,
      colors: Object.values(GarmentColor),
      viewOwner: viewOwner ?? null,
      categoryGroups: this.categoryGroups(filters.categories),
      categoryTree: this.editCategoryTree(filters.categories),
      availableLocations: filters.locations,
      availableTags: filters.tags,
      sizeGroups: this.editSizeGroups(),
    };
  }

  @Post(':id/clone')
  async cloneCreate(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      name?: string;
      category: string;
      brand?: string;
      color?: GarmentColor;
      size?: string;
      location?: string;
      tags?: string;
      notes?: string;
    },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;
    // Verify the requesting user has access to the source garment
    await this.garmentService.findOne(id, userId, viewOwner);
    const cloned = await this.garmentService.clone(
      id,
      {
        name: body.name,
        category: body.category,
        brand: body.brand,
        color: Array.isArray(body.color) ? body.color.join(',') : body.color,
        size: body.size,
        location: body.location,
        tags: body.tags,
        notes: body.notes,
      },
      userId,
    );
    return reply.redirect(`/wardrobe/${cloned.id}`, 302);
  }

  @Post(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      name?: string;
      category?: string;
      brand?: string;
      color?: GarmentColor;
      size?: string;
      location?: string;
      tags?: string;
      notes?: string;
      washingDetails?: string;
      dateAquired?: string;
    },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;

    if (userId != null && viewOwner != null && viewOwner !== userId) {
      const canManage = await this.shareService.canManage(userId, viewOwner);
      if (!canManage) throw new ForbiddenException();
    }

    await this.garmentService.update(
      id,
      {
        name: body.name,
        category: body.category,
        brand: body.brand,
        color: Array.isArray(body.color) ? body.color.join(',') : body.color,
        size: body.size,
        location: body.location,
        tags: body.tags,
        notes: body.notes,
        washingDetails: body.washingDetails,
        dateAquired: body.dateAquired,
      },
      viewOwner ?? userId,
      userId,
    );
    const redirectSuffix = viewOwner ? `?ownerId=${viewOwner}` : '';
    return reply.redirect(`/wardrobe/${id}${redirectSuffix}`, 302);
  }

  @Post(':id/photo')
  async uploadPhoto(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;

    if (userId != null && viewOwner != null && viewOwner !== userId) {
      const canManage = await this.shareService.canManage(userId, viewOwner);
      if (!canManage) throw new ForbiddenException();
    }

    const fields: Record<string, string> = {};
    const files = (async function* () {
      for await (const part of (req as any).parts({ limits: { files: 2 } })) {
        if (part.type === 'file') {
          yield part;
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
    })();
    await this.garmentService.uploadGalleryPhoto(
      id,
      files,
      fields.photoId ? parseInt(fields.photoId, 10) : undefined,
      viewOwner ?? userId,
      userId,
    );
    const redirectSuffix = viewOwner ? `?ownerId=${viewOwner}` : '';
    reply.header('HX-Redirect', `/wardrobe/${id}${redirectSuffix}`);
    return reply.send();
  }

  @Post(':id/photos/reorder')
  async reorderPhotos(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { photoIds?: string | string[] },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;

    if (userId != null && viewOwner != null && viewOwner !== userId) {
      const canManage = await this.shareService.canManage(userId, viewOwner);
      if (!canManage) throw new ForbiddenException();
    }

    const rawIds = Array.isArray(body.photoIds)
      ? body.photoIds
      : (body.photoIds ?? '').split(',');
    await this.garmentService.reorderGalleryPhotos(
      id,
      rawIds.map((value) => parseInt(value, 10)).filter(Number.isFinite),
      viewOwner ?? userId,
      userId,
    );
    const redirectSuffix = viewOwner ? `?ownerId=${viewOwner}` : '';
    reply.header('HX-Redirect', `/wardrobe/${id}${redirectSuffix}`);
    return reply.send({ ok: true });
  }

  @Post(':id/photos/:photoId/delete')
  async deletePhoto(
    @Param('id', ParseIntPipe) id: number,
    @Param('photoId', ParseIntPipe) photoId: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;

    if (userId != null && viewOwner != null && viewOwner !== userId) {
      const canManage = await this.shareService.canManage(userId, viewOwner);
      if (!canManage) throw new ForbiddenException();
    }

    await this.garmentService.removeGalleryPhoto(
      id,
      photoId,
      viewOwner ?? userId,
      userId,
    );
    const redirectSuffix = viewOwner ? `?ownerId=${viewOwner}` : '';
    reply.header('HX-Redirect', `/wardrobe/${id}${redirectSuffix}`);
    return reply.send({ ok: true });
  }

  @Post(':id/archive')
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;

    // Archive/unarchive is only allowed for the owner
    if (viewOwner != null && viewOwner !== userId) {
      throw new ForbiddenException();
    }

    await this.garmentService.archive(id, userId);
    const redirectSuffix = viewOwner ? `?ownerId=${viewOwner}` : '';
    reply.header('HX-Redirect', `/wardrobe${redirectSuffix}`);
    return reply.send();
  }

  @Post(':id/nobg')
  async updateNobg(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;

    if (userId != null && viewOwner != null && viewOwner !== userId) {
      const canManage = await this.shareService.canManage(userId, viewOwner);
      if (!canManage) throw new ForbiddenException();
    }

    const nobgPhoto = await req.file();
    await this.garmentService.updateNobg(
      id,
      nobgPhoto,
      viewOwner ?? userId,
      userId,
    );
    const redirectSuffix = viewOwner ? `?ownerId=${viewOwner}` : '';
    reply.header('HX-Redirect', `/wardrobe/${id}${redirectSuffix}`);
    return reply.send();
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('ownerId') ownerId: string | undefined,
  ) {
    const userId = this.userId(req);
    const viewOwner = ownerId ? parseInt(ownerId, 10) : undefined;

    // Delete is only allowed for the owner
    if (viewOwner != null && viewOwner !== userId) {
      throw new ForbiddenException();
    }

    await this.garmentService.remove(id, userId);
    reply.header('HX-Redirect', '/wardrobe');
    return reply.send();
  }

  private categoryGroups(categories: string[]) {
    const unique = [
      ...new Set([...DEFAULT_CATEGORY_PATHS, ...categories]),
    ].sort((a, b) => a.localeCompare(b));
    const groups = new Map<string, { label: string; options: string[] }>();
    for (const category of unique) {
      const [group] = category.split('>').map((part) => part.trim());
      if (!groups.has(group)) groups.set(group, { label: group, options: [] });
      groups.get(group)?.options.push(category);
    }
    return [...groups.values()];
  }

  private galleryPhotos(garment: any) {
    return (
      garment.photos
        ?.getItems()
        ?.map((photo) => {
          const file = (photo.file as any).unwrap?.() ?? photo.file;
          return { id: photo.id, fileName: file.fileName };
        }) ?? []
    );
  }

  private categoryPanel(
    categories: string[],
    query: SearchGarmentDto,
    viewOwner?: number,
  ) {
    const active = query.category
      ? this.canonicalCategory(query.category)
      : undefined;
    const paths = this.categoryPaths(categories);
    const options = this.categoryOptions(paths, active, query, viewOwner);
    return {
      title: active ? this.categoryLeafLabel(active) : 'Category',
      active: active ?? '',
      breadcrumbs: this.categoryBreadcrumbs(active, query, viewOwner),
      options,
    };
  }

  private categoryOptions(
    paths: string[],
    active: string | undefined,
    query: SearchGarmentDto,
    viewOwner?: number,
  ): CategoryOption[] {
    if (!active || active === 'All') {
      return [
        { label: 'Clothing', value: 'Clothing' },
        { label: 'Shoes', value: 'Shoes' },
        { label: 'Bags', value: 'Bags' },
        { label: 'Accessories', value: 'Accessories' },
        { label: 'Other', value: 'Other' },
      ].map((option) =>
        this.categoryOption(
          option.label,
          option.value,
          paths,
          query,
          viewOwner,
        ),
      );
    }

    const normalizedActive = active ? this.canonicalCategory(active) : active;
    const activeParts =
      normalizedActive === 'Clothing'
        ? []
        : normalizedActive.split('>').map((part) => part.trim());
    const nextLabels = new Set<string>();

    for (const path of paths) {
      const parts = path.split('>').map((part) => part.trim());
      if (normalizedActive === 'Clothing') {
        if (['Accessories', 'Bags', 'Other', 'Shoes'].includes(parts[0])) {
          continue;
        }
        nextLabels.add(parts[0]);
        continue;
      }

      const matches = activeParts.every((part, index) => parts[index] === part);
      if (matches && parts.length > activeParts.length) {
        nextLabels.add(parts[activeParts.length]);
      }
    }

    return [...nextLabels].map((label) => {
      const value =
        normalizedActive === 'Clothing'
          ? label
          : [...activeParts, label].join(' > ');
      return this.categoryOption(label, value, paths, query, viewOwner);
    });
  }

  private categoryOption(
    label: string,
    value: string,
    paths: string[],
    query: SearchGarmentDto,
    viewOwner?: number,
  ): CategoryOption {
    return {
      label,
      value,
      href: this.wardrobeUrl(query, { category: value }, viewOwner),
      hasChildren: this.categoryHasChildren(paths, value),
    };
  }

  private categoryHasChildren(paths: string[], value: string): boolean {
    if (value === 'Clothing') return true;
    return paths.some((path) => path.startsWith(`${value} >`));
  }

  private categoryBreadcrumbs(
    category: string | undefined,
    query: SearchGarmentDto,
    viewOwner?: number,
  ) {
    if (!category || category === 'All') return [];
    const normalized = this.canonicalCategory(category);
    const crumbs = [
      {
        label: 'All',
        href: this.wardrobeUrl(query, { category: undefined }, viewOwner),
      },
    ];
    const firstPart = normalized.split('>')[0].trim();
    if (
      normalized === 'Clothing' ||
      !['Accessories', 'Bags', 'Other', 'Shoes'].includes(firstPart)
    ) {
      crumbs.push({
        label: 'Clothing',
        href: this.wardrobeUrl(query, { category: 'Clothing' }, viewOwner),
      });
    }
    if (normalized !== 'Clothing') {
      const parts = normalized.split('>').map((part) => part.trim());
      for (let index = 0; index < parts.length; index += 1) {
        const value = parts.slice(0, index + 1).join(' > ');
        crumbs.push({
          label: parts[index],
          href: this.wardrobeUrl(query, { category: value }, viewOwner),
        });
      }
    }
    return crumbs;
  }

  private categoryPaths(categories: string[]): string[] {
    return [
      ...new Set([
        ...DEFAULT_CATEGORY_PATHS,
        ...categories.map((category) => this.canonicalCategory(category)),
      ]),
    ].filter(Boolean);
  }

  private editCategoryTree(categories: string[]): CategoryTreeNode[] {
    const paths = this.categoryPaths(categories);
    const roots = [
      { label: 'Clothing', value: 'Clothing' },
      { label: 'Shoes', value: 'Shoes' },
      { label: 'Bags', value: 'Bags' },
      { label: 'Accessories', value: 'Accessories' },
      { label: 'Other', value: 'Other' },
    ];

    return roots.map((root) => this.categoryTreeNode(root, paths));
  }

  private categoryTreeNode(
    node: { label: string; value: string },
    paths: string[],
  ): CategoryTreeNode {
    return {
      ...node,
      children: this.categoryTreeChildren(node.value, paths).map((child) =>
        this.categoryTreeNode(child, paths),
      ),
    };
  }

  private categoryTreeChildren(
    parent: string,
    paths: string[],
  ): { label: string; value: string }[] {
    const options = new Map<string, string>();
    const standaloneRoots = new Set([
      'Accessories',
      'Bags',
      'Clothing',
      'Other',
      'Shoes',
    ]);

    if (parent === 'Clothing') {
      for (const path of paths) {
        const [root] = path
          .split('>')
          .map((part) => part.trim())
          .filter(Boolean);
        if (!root || standaloneRoots.has(root)) continue;
        options.set(root, root);
      }
      return [...options.entries()].map(([value, label]) => ({
        label,
        value,
      }));
    }

    const parentParts = parent
      .split('>')
      .map((part) => part.trim())
      .filter(Boolean);

    for (const path of paths) {
      const parts = path
        .split('>')
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length <= parentParts.length) continue;
      const matchesParent = parentParts.every(
        (part, index) => parts[index] === part,
      );
      if (!matchesParent) continue;
      const childParts = parts.slice(0, parentParts.length + 1);
      const value = childParts.join(' > ');
      const label = childParts.at(-1);
      if (label) options.set(value, label);
    }

    return [...options.entries()].map(([value, label]) => ({ label, value }));
  }

  private filterChips(query: SearchGarmentDto, viewOwner?: number) {
    const chips: { label: string; href: string }[] = [];
    if (query.keyword) {
      chips.push({
        label: query.keyword,
        href: this.wardrobeUrl(query, { keyword: undefined }, viewOwner),
      });
    }
    if (query.category) {
      chips.push({
        label: this.categoryLeafLabel(query.category),
        href: this.wardrobeUrl(query, { category: undefined }, viewOwner),
      });
    }
    if (query.location) {
      chips.push({
        label: query.location,
        href: this.wardrobeUrl(query, { location: undefined }, viewOwner),
      });
    }
    if (query.size) {
      chips.push({
        label: query.size,
        href: this.wardrobeUrl(query, { size: undefined }, viewOwner),
      });
    }
    if (query.color) {
      chips.push({
        label: query.color,
        href: this.wardrobeUrl(query, { color: undefined }, viewOwner),
      });
    }
    if (query.tag) {
      chips.push({
        label: query.tag,
        href: this.wardrobeUrl(query, { tag: undefined }, viewOwner),
      });
    }
    return chips;
  }

  private categoryLeafLabel(category: string): string {
    if (category === 'Clothing') return 'Clothing';
    if (category === 'Tops & T-shirts') return 'Tops & t-shirts';
    if (category === 'Tops & t-shirts') return 'Tops & t-shirts';
    if (category === 'Jeans') return 'Jeans';
    return (
      category
        .split('>')
        .map((part) => part.trim())
        .filter(Boolean)
        .at(-1) ?? category
    );
  }

  private categoryTabActive(
    activeCategory: string | undefined,
    tabCategory: string,
  ): boolean {
    const active = activeCategory || 'All';
    const canonicalActive = this.canonicalCategory(active);
    const canonicalTab = this.canonicalCategory(tabCategory);
    if (canonicalActive === canonicalTab) return true;
    if (tabCategory === 'All') return active === 'All';
    if (tabCategory === 'Clothing') {
      const topLevel = canonicalActive.split('>')[0].trim();
      return !['All', 'Accessories', 'Bags', 'Other', 'Shoes'].includes(
        topLevel,
      );
    }
    if (canonicalTab === 'Tops & t-shirts') {
      return canonicalActive.startsWith('Tops & t-shirts');
    }
    if (canonicalTab === 'Trousers & leggings') {
      return (
        canonicalActive.startsWith('Trousers & leggings') ||
        canonicalActive.startsWith('Bottoms > Trousers') ||
        canonicalActive.startsWith('Bottoms > Cargo pants') ||
        canonicalActive.startsWith('Bottoms > Chinos') ||
        canonicalActive.startsWith('Bottoms > Joggers') ||
        canonicalActive.startsWith('Bottoms > Leggings')
      );
    }
    if (canonicalTab === 'Jeans') return canonicalActive.startsWith('Jeans');
    return canonicalActive.startsWith(canonicalTab);
  }

  private canonicalCategory(category: string): string {
    const normalized = category
      .split('>')
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' > ');
    const aliases: Array<[string, string]> = [
      ['Tops & T-shirts', 'Tops & t-shirts'],
      ['Tops', 'Tops & t-shirts'],
      ['Hoodies & Sweaters', 'Jumpers & sweaters'],
      ['Bottoms > Jeans', 'Jeans'],
      ['Bottoms > Shorts', 'Shorts & cropped trousers'],
      ['Bottoms > Skirts', 'Skirts'],
      ['Bottoms > Skorts', 'Skorts'],
      ['Bottoms > Trousers', 'Trousers & leggings'],
      ['Bottoms > Cargo pants', 'Trousers & leggings > Cargo trousers'],
      ['Bottoms > Chinos', 'Trousers & leggings > Cropped trousers & chinos'],
      ['Bottoms > Joggers', 'Trousers & leggings > Other trousers'],
      ['Bottoms > Leggings', 'Trousers & leggings > Leggings'],
      ['Suits & Sets', 'Suits & blazers'],
      ['Shoes > Trainers', 'Shoes > Sneakers'],
      ['Shoes > Boots > Over-knee boots', 'Shoes > Boots > Over-the-knee boots'],
      ['Shoes > Boots > Chelsea boots', 'Shoes > Boots > Ankle boots'],
      ['Shoes > Boots > Combat boots', 'Shoes > Boots > Work boots'],
      ['Shoes > Boots > Hiking boots', 'Shoes > Boots > Work boots'],
      ['Shoes > Flats > Ballet flats', 'Shoes > Ballerinas'],
      [
        'Shoes > Flats > Loafers',
        'Shoes > Boat shoes, loafers & moccasins',
      ],
      [
        'Shoes > Flats > Moccasins',
        'Shoes > Boat shoes, loafers & moccasins',
      ],
    ];

    for (const [from, to] of aliases) {
      if (normalized === from) return to;
      if (normalized.startsWith(`${from} >`)) {
        return `${to}${normalized.slice(from.length)}`;
      }
    }
    return normalized;
  }

  private sizeFilterGroups(query: SearchGarmentDto, viewOwner?: number) {
    return SIZE_GROUPS.map((group) => ({
      label: group.label,
      sizes: group.sizes.map((size) => ({
        label: size,
        href: this.wardrobeUrl(query, { size }, viewOwner),
        active: query.size === size,
      })),
    }));
  }

  private editSizeGroups() {
    return SIZE_GROUPS.map((group) => ({
      ...group,
      kind: group.label === 'Shoe sizes' ? 'shoes' : 'clothing',
    }));
  }

  private wardrobeUrl(
    query: SearchGarmentDto,
    overrides: Partial<SearchGarmentDto> = {},
    viewOwner?: number,
  ): string {
    const merged = { ...query, ...overrides };
    const params = new URLSearchParams();
    for (const key of [
      'keyword',
      'category',
      'location',
      'size',
      'color',
      'tag',
      'archived',
    ] as const) {
      const value = merged[key];
      if (value) params.set(key, String(value));
    }
    if (viewOwner) params.set('ownerId', String(viewOwner));
    const queryString = params.toString();
    return queryString ? `/wardrobe?${queryString}` : '/wardrobe';
  }
}
