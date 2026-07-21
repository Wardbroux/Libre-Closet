import { EntityRepository, FilterQuery } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { Garment } from '../dal/entity/garment.entity';
import { GarmentPhoto } from '../dal/entity/garment-photo.entity';
import { File } from '../dal/entity/file.entity';
import { User } from '../dal/entity/user.entity';
import { WardrobeLocation } from '../dal/entity/wardrobe-location.entity';
import { FileService } from '../file/file-service.abstract';
import { MultipartFile } from '@fastify/multipart';
import { CreateGarmentDto } from './dto/create-garment.dto';
import { UpdateGarmentDto } from './dto/update-garment.dto';
import { SearchGarmentDto } from './dto/search-garment.dto';
import {
  DEFAULT_CATEGORY_PATHS,
  GarmentCategory,
} from './garment-category.enum';
import { WardrobeShareService } from '../wardrobe-share/wardrobe-share.service';

const CANONICAL_SIZES = [
  'XX-Small',
  'X-Small',
  'Small',
  'Medium',
  'Large',
  'X-Large',
  'XX-Large',
  '3X-Large',
  '4X-Large',
  '5X-Large',
];

@Injectable()
export class GarmentService {
  private readonly logger = new Logger(GarmentService.name);

  constructor(
    @InjectRepository(Garment)
    private readonly garmentRepository: EntityRepository<Garment>,
    @InjectRepository(GarmentPhoto)
    private readonly garmentPhotoRepository: EntityRepository<GarmentPhoto>,
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    @InjectRepository(WardrobeLocation)
    private readonly locationRepository: EntityRepository<WardrobeLocation>,
    private readonly fileService: FileService,
    private readonly shareService: WardrobeShareService,
  ) {}

  resolveCategoryLabel(value: string, i18n: I18nContext): string {
    if (value.toLowerCase() === 'footwear') return 'Shoes';
    const normalized = value.toLowerCase();
    if ((Object.values(GarmentCategory) as string[]).includes(normalized)) {
      return i18n.t(`lang.CATEGORY_${normalized.toUpperCase()}`);
    }
    return value;
  }

  async findAll(
    userId?: number,
    dto: SearchGarmentDto = {},
    viewOwner?: number,
  ): Promise<Garment[]> {
    const normalizedSize = this.normalizeSize(dto.size);
    const categoryFilter = this.categoryFilter(dto.category);
    const searchConditions: FilterQuery<Garment> = {
      ...(categoryFilter ? categoryFilter : {}),
      ...(dto.color ? { color: dto.color } : {}),
      ...(normalizedSize ? { size: normalizedSize } : {}),
      ...(dto.location ? { location: dto.location } : {}),
      ...(dto.tag ? { tags: { $like: `%${dto.tag}%` } } : {}),
      ...(dto.archived !== 'true' ? { archived: false } : {}),
      ...(dto.keyword
        ? {
            $or: [
              { name: { $like: `%${dto.keyword}%` } },
              { notes: { $like: `%${dto.keyword}%` } },
              { brand: { $like: `%${dto.keyword}%` } },
              { location: { $like: `%${dto.keyword}%` } },
              { tags: { $like: `%${dto.keyword}%` } },
            ],
          }
        : {}),
    };

    if (userId != null) {
      if (viewOwner != null && viewOwner !== userId) {
        return this.garmentRepository.find(
          { owner: { id: viewOwner }, ...searchConditions },
          {
            populate: ['photo', 'photos', 'photos.file'],
            orderBy: { id: 'DESC' },
          },
        );
      }
      return this.garmentRepository.find(
        { owner: { id: userId }, ...searchConditions },
        {
          populate: ['photo', 'photos', 'photos.file'],
          orderBy: { id: 'DESC' },
        },
      );
    }
    // AUTH_ENABLED=false: only return garments that belong to no user
    return this.garmentRepository.find(
      { owner: null, ...searchConditions },
      {
        populate: ['photo', 'photos', 'photos.file'],
        orderBy: { id: 'DESC' },
      },
    );
  }

  async findOne(
    id: number,
    userId?: number,
    viewOwner?: number,
  ): Promise<Garment> {
    const garment = await this.garmentRepository.findOne(id, {
      populate: ['photo', 'photos', 'photos.file', 'outfits'],
    });
    if (!garment) throw new NotFoundException('Garment not found');
    if (userId != null) {
      if (garment.owner?.id === userId) return garment;
      if (viewOwner != null && garment.owner?.id === viewOwner) {
        if (await this.shareService.canView(userId, viewOwner)) {
          return garment;
        }
      }
      throw new ForbiddenException();
    } else {
      if (garment.owner != null) throw new ForbiddenException();
    }
    return garment;
  }

  async findOneByShareableId(shareableId: string): Promise<Garment> {
    const garment = await this.garmentRepository.findOne(
      { shareableId },
      { populate: ['photo', 'photos', 'photos.file'] },
    );
    if (!garment) throw new NotFoundException('Garment not found');
    return garment;
  }

  async create(dto: CreateGarmentDto, userId?: number): Promise<Garment> {
    const photo = dto.files
      ? await this.storeUploadedPhoto(dto.files, userId)
      : undefined;

    const garment = this.garmentRepository.create({
      name: dto.name,
      category: this.normalizeCategory(dto.category) ?? dto.category,
      brand: dto.brand,
      color: dto.color,
      size: this.normalizeSize(dto.size),
      location: this.normalizeText(dto.location),
      tags: this.normalizeTags(dto.tags),
      notes: dto.notes,
      washingDetails: dto.washingDetails,
      dateAquired: dto.dateAquired ? new Date(dto.dateAquired) : undefined,
      photo: photo ?? undefined,
    });

    if (userId != null) {
      const user = await this.userRepository.findOneOrFail(userId);
      garment.owner = user as any;
    }

    await this.garmentRepository.getEntityManager().persistAndFlush(garment);
    if (photo) await this.addGarmentPhoto(garment, photo, true);
    return garment;
  }

  async clone(
    sourceId: number,
    dto: {
      name?: string;
      category: string;
      brand?: string;
      color?: string;
      size?: string;
      location?: string;
      tags?: string;
      notes?: string;
    },
    userId?: number,
  ): Promise<Garment> {
    const source = await this.garmentRepository.findOne(sourceId, {
      populate: ['photo', 'photos', 'photos.file'],
    });
    if (!source) throw new NotFoundException('Garment not found');

    let photo: File | undefined;
    if (source.photo?.fileName) {
      photo = await this.fileService.copyImage(source.photo.fileName, userId);
      if (photo) {
        const nobgSourceName = this.fileService.nobgFileName(
          source.photo.fileName,
        );
        const nobgStream = await this.fileService
          .get(nobgSourceName)
          .catch(() => undefined);
        if (nobgStream) {
          await this.fileService
            .storeNobgVariantFromStream(nobgStream, photo.fileName)
            .catch((err) => this.logger.warn(err));
        }
      }
    }

    const garment = this.garmentRepository.create({
      name: dto.name,
      category: this.normalizeCategory(dto.category) ?? dto.category,
      brand: dto.brand,
      color: dto.color as any,
      size: this.normalizeSize(dto.size),
      location: this.normalizeText(dto.location),
      tags: this.normalizeTags(dto.tags),
      notes: dto.notes,
      photo: photo ?? undefined,
    });

    if (userId != null) {
      const user = await this.userRepository.findOneOrFail(userId);
      garment.owner = user as any;
    }

    await this.garmentRepository.getEntityManager().persistAndFlush(garment);
    if (photo) await this.addGarmentPhoto(garment, photo, true);
    return garment;
  }

  async findAvailableFilters(userId?: number): Promise<{
    brands: string[];
    sizes: string[];
    categories: string[];
    locations: string[];
    tags: string[];
  }> {
    const where = userId != null ? { owner: { id: userId } } : { owner: null };
    const [garments, savedLocations] = await Promise.all([
      this.garmentRepository.find(where),
      this.locationRepository.find(where, { orderBy: { name: 'ASC' } }),
    ]);

    const brands = [
      ...new Set(garments.map((g) => g.brand).filter(Boolean) as string[]),
    ].sort();
    const allSizes = [
      ...new Set(garments.map((g) => g.size).filter(Boolean) as string[]),
    ];
    const sizes = allSizes.sort((a, b) => {
      const ai = CANONICAL_SIZES.indexOf(a);
      const bi = CANONICAL_SIZES.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    const categories = [
      ...new Set([
        ...DEFAULT_CATEGORY_PATHS,
        ...garments.map((g) => this.normalizeCategory(g.category)),
      ]),
    ]
      .filter(Boolean)
      .sort();

    const locations = [
      ...new Set([
        ...savedLocations.map((location) => location.name),
        ...(garments.map((g) => g.location).filter(Boolean) as string[]),
      ]),
    ].sort();
    const tags = [
      ...new Set(
        garments.flatMap((g) => this.parseTags(g.tags)).filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b));

    return { brands, sizes, categories, locations, tags };
  }

  async createLocation(name: string, userId?: number): Promise<void> {
    const normalizedName = this.normalizeText(name);
    if (!normalizedName) return;
    const ownerFilter =
      userId != null ? { owner: { id: userId } } : { owner: null };
    const existing = await this.locationRepository.findOne({
      name: normalizedName,
      ...ownerFilter,
    });
    if (existing) return;

    const location = this.locationRepository.create({ name: normalizedName });
    if (userId != null) {
      const user = await this.userRepository.findOneOrFail(userId);
      location.owner = user as any;
    }
    await this.locationRepository.getEntityManager().persistAndFlush(location);
  }

  async removeLocation(name: string, userId?: number): Promise<void> {
    const normalizedName = this.normalizeText(name);
    if (!normalizedName) return;
    const ownerFilter =
      userId != null ? { owner: { id: userId } } : { owner: null };
    const location = await this.locationRepository.findOne({
      name: normalizedName,
      ...ownerFilter,
    });
    if (!location) return;
    await this.locationRepository.getEntityManager().removeAndFlush(location);
  }

  async update(
    id: number,
    dto: UpdateGarmentDto,
    userId?: number,
    requestingUserId?: number,
  ): Promise<Garment> {
    let photo: File | undefined;
    if (dto.files) {
      // Process file uploads BEFORE any async DB operations.
      // @fastify/multipart yields live streams; if a stream isn't consumed,
      // the parser backpressures and the async iterator hangs. Each file's
      // pipeline must be started (not awaited) inside the loop so busboy can
      // advance to the next part.
      //
      // IMPORTANT: photo and nobgPhoto pipelines must be started concurrently,
      // not sequentially. Both come from the same multipart request body —
      // awaiting one before starting the other would hang the iterator.
      let photoPromise: Promise<File> | undefined;
      let nobgPromise: Promise<void> | undefined;
      const photoFileName = `${randomUUID()}.webp`;

      for await (const file of dto.files) {
        if (file.fieldname === 'photo') {
          photoPromise = this.fileService.storeImageFromFileUpload(
            file,
            userId,
            photoFileName,
          );
        } else if (file.fieldname === 'nobgPhoto') {
          nobgPromise = this.fileService.storeNobgVariantFromStream(
            file.file,
            photoFileName,
          );
        } else {
          file.file.resume();
        }
      }

      if (photoPromise) {
        [photo] = await Promise.all([
          photoPromise,
          nobgPromise ?? Promise.resolve(),
        ]);
      }
    }

    const garment = await this.findOne(id, requestingUserId, userId);

    if (photo) {
      await this.deleteOldPhoto(garment);
      garment.photo = photo as any;
    }

    garment.name = dto.name ?? garment.name;
    garment.category = this.normalizeCategory(dto.category) ?? garment.category;
    if ('brand' in dto) garment.brand = dto.brand;
    if ('color' in dto) garment.color = dto.color;
    if ('size' in dto) garment.size = this.normalizeSize(dto.size);
    if ('location' in dto) garment.location = this.normalizeText(dto.location);
    if ('tags' in dto) garment.tags = this.normalizeTags(dto.tags);
    if ('notes' in dto) garment.notes = dto.notes;
    if ('washingDetails' in dto) garment.washingDetails = dto.washingDetails;
    if ('dateAquired' in dto)
      garment.dateAquired = dto.dateAquired
        ? new Date(dto.dateAquired)
        : undefined;

    await this.garmentRepository.getEntityManager().flush();
    return garment;
  }

  async uploadGalleryPhoto(
    id: number,
    files: AsyncIterableIterator<MultipartFile>,
    photoId?: number,
    userId?: number,
    requestingUserId?: number,
  ): Promise<void> {
    const photo = await this.storeUploadedPhoto(files, userId);
    if (!photo) return;
    const garment = await this.findOne(id, requestingUserId, userId);
    if (photoId) {
      await this.replaceGarmentPhoto(garment, photoId, photo);
      return;
    }
    await this.addGarmentPhoto(garment, photo, !garment.photo);
  }

  private async storeUploadedPhoto(
    files: AsyncIterableIterator<MultipartFile>,
    userId?: number,
  ): Promise<File | undefined> {
    let photoPromise: Promise<File> | undefined;
    let nobgPromise: Promise<void> | undefined;
    const photoFileName = `${randomUUID()}.webp`;

    for await (const file of files) {
      if (file.fieldname === 'photo') {
        photoPromise = this.fileService.storeImageFromFileUpload(
          file,
          userId,
          photoFileName,
        );
      } else if (file.fieldname === 'nobgPhoto') {
        nobgPromise = this.fileService.storeNobgVariantFromStream(
          file.file,
          photoFileName,
        );
      } else {
        file.file.resume();
      }
    }

    if (!photoPromise) return undefined;
    const [photo] = await Promise.all([
      photoPromise,
      nobgPromise ?? Promise.resolve(),
    ]);
    return photo;
  }

  private async addGarmentPhoto(
    garment: Garment,
    photo: File,
    makeMain = false,
  ): Promise<void> {
    await garment.photos.init();
    const galleryPhoto = this.garmentPhotoRepository.create({
      garment,
      file: photo,
      position: garment.photos.length,
      createdOn: new Date().toISOString(),
    });
    if (makeMain) garment.photo = photo as any;
    await this.garmentRepository
      .getEntityManager()
      .persistAndFlush(galleryPhoto);
  }

  private async replaceGarmentPhoto(
    garment: Garment,
    photoId: number,
    photo: File,
  ): Promise<void> {
    await garment.photos.init();
    const galleryPhoto = garment.photos
      .getItems()
      .find((item) => item.id === photoId);
    if (!galleryPhoto) throw new NotFoundException('Photo not found');
    const oldFile = (galleryPhoto.file as any).unwrap?.() ?? galleryPhoto.file;
    const oldFileName = oldFile?.fileName;
    const replacingMain = garment.photo?.id === oldFile?.id;
    galleryPhoto.file = photo as any;
    if (replacingMain || galleryPhoto.position === 0) garment.photo = photo as any;
    await this.garmentRepository.getEntityManager().flush();
    if (oldFileName) await this.deletePhotoFiles(oldFileName);
  }

  private async deleteOldPhoto(garment: Garment) {
    const oldFileName = garment.photo?.fileName;
    if (oldFileName) {
      await this.deletePhotoFiles(oldFileName);
    }
  }

  private async deletePhotoFiles(fileName: string): Promise<void> {
    await this.fileService.delete(fileName).catch((err) => this.logger.warn(err));
    const nobgFileName = this.fileService.nobgFileName(fileName);
    await this.fileService
      .delete(nobgFileName)
      .catch((err) => this.logger.warn(err));
  }

  async updateNobg(
    id: number,
    nobgPhoto: MultipartFile | undefined,
    userId?: number,
    requestingUserId?: number,
  ): Promise<void> {
    const garment = await this.findOne(id, requestingUserId, userId);
    if (!garment.photo?.fileName) return;
    await this.streamNobgIfPresent(nobgPhoto, garment.photo.fileName);
  }

  private streamNobgIfPresent(
    nobgPhoto: MultipartFile | undefined,
    photoFileName: string,
  ): Promise<void> {
    if (!nobgPhoto) return Promise.resolve();
    const fileStream = nobgPhoto.file;
    return this.fileService.storeNobgVariantFromStream(
      fileStream,
      photoFileName,
    );
  }

  async remove(id: number, userId?: number): Promise<void> {
    const garment = await this.findOne(id, userId);
    await this.garmentRepository.getEntityManager().removeAndFlush(garment);
  }

  async archive(id: number, userId?: number): Promise<Garment> {
    const garment = await this.findOne(id, userId);
    garment.archived = !garment.archived;
    await this.garmentRepository.getEntityManager().flush();
    return garment;
  }

  private normalizeSize(input?: string): string | undefined {
    if (!input) return undefined;
    const s = input
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '');
    if (['xxxxxl', '5xl', '5xlarge', 'xxxxxlarge'].includes(s))
      return '5X-Large';
    if (['xxxxl', '4xl', '4xlarge', 'xxxxlarge'].includes(s)) return '4X-Large';
    if (['xxxl', '3xl', '3xlarge', 'xxxlarge'].includes(s)) return '3X-Large';
    if (['xxl', '2xl', '2xlarge', 'xxlarge'].includes(s)) return 'XX-Large';
    if (['xl', 'xlarge'].includes(s)) return 'X-Large';
    if (['l', 'large'].includes(s)) return 'Large';
    if (['m', 'medium'].includes(s)) return 'Medium';
    if (['s', 'small'].includes(s)) return 'Small';
    if (['xs', 'xsmall'].includes(s)) return 'X-Small';
    if (['xxs', '2xs', '2xsmall', 'xxsmall'].includes(s)) return 'XX-Small';
    return input.trim();
  }

  private normalizeText(input?: string): string | undefined {
    const value = input?.trim();
    return value || undefined;
  }

  private normalizeCategory(input?: string): string | undefined {
    const value = this.normalizeText(input);
    if (!value) return undefined;
    if (value.toLowerCase() === 'footwear') return 'Shoes > Sneakers';
    const normalized = value
      .split('>')
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' > ');
    return this.normalizeCategoryAlias(normalized);
  }

  private categoryFilter(category?: string): FilterQuery<Garment> | undefined {
    const value = this.normalizeCategory(category);
    if (!value || value === 'All') return undefined;
    if (value === 'Clothing') {
      return {
        $or: [
          { category: { $like: 'Tops & t-shirts%' } },
          { category: { $like: 'Dresses%' } },
          { category: { $like: 'Jumpers & sweaters%' } },
          { category: { $like: 'Trousers & leggings%' } },
          { category: { $like: 'Skirts%' } },
          { category: { $like: 'Jeans%' } },
          { category: { $like: 'Shorts & cropped trousers%' } },
          { category: { $like: 'Outerwear%' } },
          { category: { $like: 'Activewear%' } },
          { category: { $like: 'Swimwear%' } },
          { category: { $like: 'Suits & blazers%' } },
          { category: { $like: 'Lingerie & nightwear%' } },
          { category: { $like: 'Jumpsuits & playsuits%' } },
          { category: 'Costumes & special outfits' },
          { category: 'Other clothing' },
          { category: { $like: 'Tops%' } },
          { category: { $like: 'Hoodies & Sweaters%' } },
          { category: { $like: 'Bottoms%' } },
          { category: { $like: 'Suits & Sets%' } },
        ],
      };
    }
    if (value === 'Tops & t-shirts') {
      return {
        $or: [
          { category: { $like: 'Tops & t-shirts%' } },
          { category: { $like: 'Tops%' } },
        ],
      };
    }
    if (value === 'Trousers & leggings') {
      return {
        $or: [
          { category: { $like: 'Trousers & leggings%' } },
          { category: { $like: 'Bottoms > Trousers%' } },
          { category: { $like: 'Bottoms > Cargo pants%' } },
          { category: { $like: 'Bottoms > Chinos%' } },
          { category: { $like: 'Bottoms > Joggers%' } },
          { category: { $like: 'Bottoms > Leggings%' } },
        ],
      };
    }
    if (value === 'Shorts & cropped trousers') {
      return {
        $or: [
          { category: { $like: 'Shorts & cropped trousers%' } },
          { category: { $like: 'Bottoms > Shorts%' } },
        ],
      };
    }
    if (value === 'Skirts') {
      return {
        $or: [
          { category: { $like: 'Skirts%' } },
          { category: { $like: 'Bottoms > Skirts%' } },
        ],
      };
    }
    if (value === 'Skorts') {
      return {
        $or: [{ category: 'Skorts' }, { category: 'Bottoms > Skorts' }],
      };
    }
    if (value === 'Jeans') {
      return {
        $or: [
          { category: { $like: 'Jeans%' } },
          { category: { $like: 'Bottoms > Jeans%' } },
        ],
      };
    }
    if (value === 'Jumpers & sweaters') {
      return {
        $or: [
          { category: { $like: 'Jumpers & sweaters%' } },
          { category: { $like: 'Hoodies & Sweaters%' } },
        ],
      };
    }
    if (value === 'Suits & blazers') {
      return {
        $or: [
          { category: { $like: 'Suits & blazers%' } },
          { category: { $like: 'Suits & Sets%' } },
        ],
      };
    }
    if (value === 'Shoes') {
      return {
        $or: [{ category: { $like: 'Shoes%' } }, { category: 'footwear' }],
      };
    }
    return {
      $or: [{ category: value }, { category: { $like: `${value} >%` } }],
    };
  }

  private normalizeCategoryAlias(category: string): string {
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
      if (category === from) return to;
      if (category.startsWith(`${from} >`)) {
        return `${to}${category.slice(from.length)}`;
      }
    }
    return category;
  }

  private normalizeTags(input?: string): string | undefined {
    const tags = this.parseTags(input);
    if (!tags.length) return undefined;
    return [...new Set(tags.map((tag) => this.titleTag(tag)))].join(',');
  }

  private parseTags(input?: string): string[] {
    if (!input) return [];
    return input
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  private titleTag(input: string): string {
    return input
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}
