const { DataTypes } = require('sequelize');
const mongoose = require('mongoose');

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

const defineModels = (sequelize) => {
    const User = sequelize.define(
        'User',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            name: { type: DataTypes.STRING, allowNull: false },
            title: { type: DataTypes.STRING, allowNull: false },
            email: { type: DataTypes.STRING, allowNull: false, unique: true },
            emailVerified: { type: DataTypes.BOOLEAN },
            registrationEmailPending: { type: DataTypes.BOOLEAN },
            password: { type: DataTypes.STRING },
            role: {
                type: DataTypes.ENUM('super_admin', 'admin', 'manager', 'developer', 'tester', 'user'),
                allowNull: false,
                defaultValue: 'user'
            },
            accountStatus: {
                type: DataTypes.ENUM('active', 'banned'),
                allowNull: false,
                defaultValue: 'active'
            },
            lastLoginAt: { type: DataTypes.DATE, defaultValue: null },
            inviteTokenHash: { type: DataTypes.STRING, defaultValue: null },
            inviteExpiresAt: { type: DataTypes.DATE, defaultValue: null },
            inviteAcceptedAt: { type: DataTypes.DATE, defaultValue: null },
            inviteInvitedByUserId: { type: DataTypes.STRING(24), defaultValue: null },
            inviteCompanyId: { type: DataTypes.STRING(24), defaultValue: null }
        },
        {
            tableName: 'users',
            timestamps: true
        }
    );

    const Company = sequelize.define(
        'Company',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            name: { type: DataTypes.STRING, allowNull: false },
            email: { type: DataTypes.STRING, allowNull: false },
            platformStatus: {
                type: DataTypes.ENUM('active', 'suspended'),
                allowNull: false,
                defaultValue: 'active'
            },
            deletedAt: { type: DataTypes.DATE, defaultValue: null },
            subscriptionPlanId: { type: DataTypes.STRING, allowNull: false, defaultValue: 'free' },
            subscriptionStatus: {
                type: DataTypes.ENUM('active', 'pending', 'expired', 'cancelled'),
                allowNull: false,
                defaultValue: 'active'
            },
            subscriptionIsTrial: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            subscriptionTrialEndsAt: { type: DataTypes.DATE, defaultValue: null },
            subscriptionExpiresAt: { type: DataTypes.DATE, defaultValue: null },
            subscriptionGraceEndsAt: { type: DataTypes.DATE, defaultValue: null },
            subscriptionPendingPlanId: { type: DataTypes.STRING, defaultValue: null },
            paymobOrderId: { type: DataTypes.STRING, defaultValue: null },
            paymobTransactionId: { type: DataTypes.STRING, defaultValue: null },
            paymobSubscriptionId: { type: DataTypes.STRING, defaultValue: null },
            subscriptionUpdatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            lastBillingFailureAt: { type: DataTypes.DATE, defaultValue: null },
            lastBillingFailureReason: { type: DataTypes.STRING, defaultValue: null }
        },
        {
            tableName: 'companies',
            timestamps: true
        }
    );

    const UserCompany = sequelize.define(
        'UserCompany',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            displayName: { type: DataTypes.STRING },
            companyRole: {
                type: DataTypes.ENUM('owner', 'admin', 'manager', 'developer', 'tester', 'user'),
                allowNull: false,
                defaultValue: 'user'
            },
            isOwner: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
        },
        {
            tableName: 'user_companies',
            timestamps: true,
            indexes: [{ unique: true, fields: ['userId', 'companyId'] }]
        }
    );

    const CompanyMember = sequelize.define(
        'CompanyMember',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            role: {
                type: DataTypes.ENUM('owner', 'admin', 'manager', 'developer', 'tester', 'user'),
                allowNull: false,
                defaultValue: 'user'
            },
            isOwner: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
        },
        {
            tableName: 'company_members',
            timestamps: true,
            indexes: [{ unique: true, fields: ['companyId', 'userId'] }]
        }
    );

    const UserFcmToken = sequelize.define(
        'UserFcmToken',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            token: { type: DataTypes.STRING, allowNull: false }
        },
        {
            tableName: 'user_fcm_tokens',
            timestamps: true,
            indexes: [{ unique: true, fields: ['userId', 'token'] }]
        }
    );

    const Project = sequelize.define(
        'Project',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            project_name: { type: DataTypes.STRING, allowNull: false },
            start_date: { type: DataTypes.DATE, allowNull: false },
            estimated_end_date: { type: DataTypes.DATE, allowNull: false },
            status: {
                type: DataTypes.ENUM('active', 'completed', 'on_hold', 'cancelled'),
                allowNull: false,
                defaultValue: 'active'
            }
        },
        {
            tableName: 'projects',
            timestamps: true
        }
    );

    const ProjectAssignee = sequelize.define(
        'ProjectAssignee',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString }
        },
        {
            tableName: 'project_assignees',
            timestamps: true,
            indexes: [{ unique: true, fields: ['projectId', 'userId'] }]
        }
    );

    const Ticket = sequelize.define(
        'Ticket',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            ticket: { type: DataTypes.STRING, allowNull: false },
            requested_from: { type: DataTypes.STRING, allowNull: false },
            requested_from_email: { type: DataTypes.STRING, allowNull: false },
            requested_to: { type: DataTypes.STRING, allowNull: false },
            requested_to_email: { type: DataTypes.STRING, allowNull: false },
            date: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            time: { type: DataTypes.STRING },
            description: { type: DataTypes.TEXT, allowNull: false },
            status: {
                type: DataTypes.ENUM('open', 'in_progress', 'resolved', 'closed'),
                allowNull: false,
                defaultValue: 'open'
            },
            priority: { type: DataTypes.STRING },
            comment: { type: DataTypes.TEXT },
            end_date: { type: DataTypes.DATE }
        },
        {
            tableName: 'tickets',
            timestamps: true,
            indexes: [{ unique: true, fields: ['ticket', 'projectId'] }]
        }
    );

    const TicketReply = sequelize.define(
        'TicketReply',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            user: { type: DataTypes.STRING, allowNull: false },
            userEmail: { type: DataTypes.STRING, allowNull: false },
            comment: { type: DataTypes.TEXT, allowNull: false }
        },
        {
            tableName: 'ticket_replies',
            timestamps: true
        }
    );

    const TicketReplyImage = sequelize.define(
        'TicketReplyImage',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            imageUrl: { type: DataTypes.STRING, allowNull: false }
        },
        {
            tableName: 'ticket_reply_images',
            timestamps: true
        }
    );

    const TicketImage = sequelize.define(
        'TicketImage',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            imageUrl: { type: DataTypes.STRING, allowNull: false }
        },
        {
            tableName: 'ticket_images',
            timestamps: true
        }
    );

    const TicketHandler = sequelize.define(
        'TicketHandler',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            handlerEmail: { type: DataTypes.STRING, allowNull: false }
        },
        {
            tableName: 'ticket_handlers',
            timestamps: true
        }
    );

    const TicketCc = sequelize.define(
        'TicketCc',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            ccEmail: { type: DataTypes.STRING, allowNull: false }
        },
        {
            tableName: 'ticket_cc',
            timestamps: true
        }
    );

    const Conversation = sequelize.define(
        'Conversation',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            companyId: { type: DataTypes.STRING(24), allowNull: true },
            lastMessageId: { type: DataTypes.STRING(24), allowNull: true },
            lastMessageAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
            unreadCount: { type: DataTypes.JSONB, defaultValue: {} },
            isGroup: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            groupName: { type: DataTypes.STRING },
            groupDescription: { type: DataTypes.TEXT },
            groupAdminId: { type: DataTypes.STRING(24), allowNull: true },
            projectId: { type: DataTypes.STRING(24), allowNull: true }
        },
        { tableName: 'conversations', timestamps: true }
    );

    const ConversationParticipant = sequelize.define(
        'ConversationParticipant',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            conversationId: { type: DataTypes.STRING(24), allowNull: false },
            userId: { type: DataTypes.STRING(24), allowNull: false },
            sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
        },
        {
            tableName: 'conversation_participants',
            timestamps: false,
            indexes: [{ unique: true, fields: ['conversationId', 'userId'] }]
        }
    );

    const Message = sequelize.define(
        'Message',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            companyId: { type: DataTypes.STRING(24), allowNull: true },
            conversationId: { type: DataTypes.STRING(24), allowNull: false },
            senderId: { type: DataTypes.STRING(24), allowNull: false },
            senderName: { type: DataTypes.STRING, allowNull: false },
            senderEmail: { type: DataTypes.STRING, allowNull: false },
            type: {
                type: DataTypes.ENUM('text', 'voice', 'image', 'video', 'file'),
                allowNull: false,
                defaultValue: 'text'
            },
            content: { type: DataTypes.TEXT },
            fileUrl: { type: DataTypes.STRING },
            fileName: { type: DataTypes.STRING },
            fileSize: { type: DataTypes.INTEGER },
            mimeType: { type: DataTypes.STRING },
            duration: { type: DataTypes.INTEGER },
            thumbnail: { type: DataTypes.STRING },
            replyToId: { type: DataTypes.STRING(24), allowNull: true },
            isEdited: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            editedAt: { type: DataTypes.DATE },
            isDeleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            deletedAt: { type: DataTypes.DATE },
            parentMessageId: { type: DataTypes.STRING(24), allowNull: true },
            isThread: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            threadCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
        },
        { tableName: 'messages', timestamps: true }
    );

    const MessageReadBy = sequelize.define(
        'MessageReadBy',
        {
            messageId: { type: DataTypes.STRING(24), primaryKey: true },
            userId: { type: DataTypes.STRING(24), primaryKey: true },
            readAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
        },
        { tableName: 'message_read_by', timestamps: false }
    );

    const MessageMention = sequelize.define(
        'MessageMention',
        {
            messageId: { type: DataTypes.STRING(24), primaryKey: true },
            userId: { type: DataTypes.STRING(24), primaryKey: true }
        },
        { tableName: 'message_mentions', timestamps: false }
    );

    const MessageReaction = sequelize.define(
        'MessageReaction',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            messageId: { type: DataTypes.STRING(24), allowNull: false },
            userId: { type: DataTypes.STRING(24), allowNull: false },
            emoji: { type: DataTypes.STRING },
            createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
        },
        { tableName: 'message_reactions', timestamps: false }
    );

    const Notification = sequelize.define(
        'Notification',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            companyId: { type: DataTypes.STRING(24), allowNull: true },
            userId: { type: DataTypes.STRING(24), allowNull: false },
            type: { type: DataTypes.STRING, allowNull: false },
            title: { type: DataTypes.STRING, allowNull: false },
            body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            data: { type: DataTypes.JSONB, defaultValue: {} },
            read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            readAt: { type: DataTypes.DATE }
        },
        { tableName: 'notifications', timestamps: true }
    );

    const Attendance = sequelize.define(
        'Attendance',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            companyId: { type: DataTypes.STRING(24), allowNull: true },
            userId: { type: DataTypes.STRING(24), allowNull: false },
            date: { type: DataTypes.STRING, allowNull: false },
            checkIn: { type: DataTypes.DATE, allowNull: false },
            continuousCheckIn: { type: DataTypes.DATE },
            checkOut: { type: DataTypes.DATE },
            duration: { type: DataTypes.INTEGER, defaultValue: 0 },
            status: {
                type: DataTypes.ENUM('present', 'half-day', 'absent'),
                allowNull: false,
                defaultValue: 'present'
            },
            note: { type: DataTypes.TEXT },
            checkInLatitude: { type: DataTypes.DOUBLE },
            checkInLongitude: { type: DataTypes.DOUBLE },
            checkOutLatitude: { type: DataTypes.DOUBLE },
            checkOutLongitude: { type: DataTypes.DOUBLE },
            lastEditedByUserId: { type: DataTypes.STRING(24), allowNull: true },
            lastEditedAt: { type: DataTypes.DATE }
        },
        { tableName: 'attendances', timestamps: true }
    );

    const Version = sequelize.define(
        'Version',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            version: { type: DataTypes.STRING, allowNull: false }
        },
        { tableName: 'versions', timestamps: true }
    );

    const SubscriptionPlanContent = sequelize.define(
        'SubscriptionPlanContent',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            // STRING not ENUM: Sequelize alter+ENUM+UNIQUE emits invalid PostgreSQL SQL.
            planId: { type: DataTypes.STRING(32), allowNull: false, unique: true },
            translations: { type: DataTypes.JSONB, allowNull: false }
        },
        { tableName: 'subscription_plan_contents', timestamps: true }
    );

    const PlanCatalogOverride = sequelize.define(
        'PlanCatalogOverride',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            planId: { type: DataTypes.STRING(32), allowNull: false, unique: true },
            name: { type: DataTypes.STRING },
            description: { type: DataTypes.TEXT },
            price: { type: DataTypes.DOUBLE },
            currency: { type: DataTypes.STRING },
            billingPeriod: { type: DataTypes.STRING },
            features: { type: DataTypes.JSONB },
            isActive: { type: DataTypes.BOOLEAN },
            isPopular: { type: DataTypes.BOOLEAN },
            trialDays: { type: DataTypes.INTEGER },
            paymobIntegrationId: { type: DataTypes.INTEGER },
            paymobSubscriptionPlanId: { type: DataTypes.INTEGER },
            limits: { type: DataTypes.JSONB }
        },
        { tableName: 'plan_catalog_overrides', timestamps: true }
    );

    const ProjectPersonalNote = sequelize.define(
        'ProjectPersonalNote',
        {
            id: { type: DataTypes.STRING(24), primaryKey: true, defaultValue: newObjectIdString },
            projectId: { type: DataTypes.STRING(24), allowNull: false },
            userId: { type: DataTypes.STRING(24), allowNull: false },
            content: { type: DataTypes.TEXT, allowNull: false }
        },
        {
            tableName: 'project_personal_notes',
            timestamps: true,
            indexes: [{ unique: false, fields: ['projectId', 'userId'] }]
        }
    );

    const models = {
        User,
        Company,
        UserCompany,
        CompanyMember,
        UserFcmToken,
        Project,
        ProjectAssignee,
        Ticket,
        TicketReply,
        TicketReplyImage,
        TicketImage,
        TicketHandler,
        TicketCc,
        Conversation,
        ConversationParticipant,
        Message,
        MessageReadBy,
        MessageMention,
        MessageReaction,
        Notification,
        Attendance,
        Version,
        SubscriptionPlanContent,
        PlanCatalogOverride,
        ProjectPersonalNote
    };

    Company.belongsTo(User, { as: 'ownerUser', foreignKey: { name: 'ownerUserId', allowNull: false }, onDelete: 'RESTRICT' });
    User.hasMany(Company, { as: 'ownedCompanies', foreignKey: 'ownerUserId' });

    User.belongsToMany(Company, {
        through: UserCompany,
        as: 'companyLinks',
        foreignKey: 'userId',
        otherKey: 'companyId'
    });
    Company.belongsToMany(User, {
        through: UserCompany,
        as: 'userLinks',
        foreignKey: 'companyId',
        otherKey: 'userId'
    });

    Company.belongsToMany(User, {
        through: CompanyMember,
        as: 'memberUsers',
        foreignKey: 'companyId',
        otherKey: 'userId'
    });
    User.belongsToMany(Company, {
        through: CompanyMember,
        as: 'memberCompanies',
        foreignKey: 'userId',
        otherKey: 'companyId'
    });

    User.hasMany(UserFcmToken, { as: 'fcmTokens', foreignKey: { name: 'userId', allowNull: false }, onDelete: 'CASCADE' });
    UserFcmToken.belongsTo(User, { foreignKey: { name: 'userId', allowNull: false }, onDelete: 'CASCADE' });

    Project.belongsTo(Company, { foreignKey: { name: 'companyId', allowNull: true }, onDelete: 'SET NULL' });
    Company.hasMany(Project, { foreignKey: 'companyId' });

    Project.belongsToMany(User, {
        through: ProjectAssignee,
        as: 'assignedUsers',
        foreignKey: 'projectId',
        otherKey: 'userId'
    });
    User.belongsToMany(Project, {
        through: ProjectAssignee,
        as: 'assignedProjects',
        foreignKey: 'userId',
        otherKey: 'projectId'
    });

    Ticket.belongsTo(Company, { foreignKey: { name: 'companyId', allowNull: true }, onDelete: 'SET NULL' });
    Company.hasMany(Ticket, { foreignKey: 'companyId' });
    Ticket.belongsTo(Project, { foreignKey: { name: 'projectId', allowNull: false }, onDelete: 'RESTRICT' });
    Project.hasMany(Ticket, { foreignKey: 'projectId' });

    TicketReply.belongsTo(Ticket, { foreignKey: { name: 'ticketId', allowNull: false }, onDelete: 'CASCADE' });
    Ticket.hasMany(TicketReply, { as: 'replies', foreignKey: 'ticketId' });
    TicketReply.belongsTo(User, { foreignKey: { name: 'userId', allowNull: false }, onDelete: 'RESTRICT' });
    User.hasMany(TicketReply, { foreignKey: 'userId' });

    TicketReplyImage.belongsTo(TicketReply, { foreignKey: { name: 'ticketReplyId', allowNull: false }, onDelete: 'CASCADE' });
    TicketReply.hasMany(TicketReplyImage, { as: 'images', foreignKey: 'ticketReplyId' });

    TicketImage.belongsTo(Ticket, { foreignKey: { name: 'ticketId', allowNull: false }, onDelete: 'CASCADE' });
    Ticket.hasMany(TicketImage, { as: 'images', foreignKey: 'ticketId' });

    TicketHandler.belongsTo(Ticket, { foreignKey: { name: 'ticketId', allowNull: false }, onDelete: 'CASCADE' });
    Ticket.hasMany(TicketHandler, { as: 'handlers', foreignKey: 'ticketId' });

    TicketCc.belongsTo(Ticket, { foreignKey: { name: 'ticketId', allowNull: false }, onDelete: 'CASCADE' });
    Ticket.hasMany(TicketCc, { as: 'cc', foreignKey: 'ticketId' });

    Conversation.belongsTo(Company, { foreignKey: { name: 'companyId', allowNull: true }, onDelete: 'SET NULL' });
    Company.hasMany(Conversation, { foreignKey: 'companyId' });
    Conversation.belongsTo(Project, { foreignKey: { name: 'projectId', allowNull: true }, onDelete: 'SET NULL' });
    Project.hasMany(Conversation, { foreignKey: 'projectId' });
    Conversation.belongsTo(User, { as: 'groupAdmin', foreignKey: { name: 'groupAdminId', allowNull: true }, onDelete: 'SET NULL' });

    ConversationParticipant.belongsTo(Conversation, { foreignKey: { name: 'conversationId', allowNull: false }, onDelete: 'CASCADE' });
    Conversation.hasMany(ConversationParticipant, { foreignKey: 'conversationId' });
    ConversationParticipant.belongsTo(User, { foreignKey: { name: 'userId', allowNull: false }, onDelete: 'CASCADE' });

    Message.belongsTo(Conversation, { foreignKey: { name: 'conversationId', allowNull: false }, onDelete: 'CASCADE' });
    Conversation.hasMany(Message, { foreignKey: 'conversationId' });
    Message.belongsTo(Company, { foreignKey: { name: 'companyId', allowNull: true }, onDelete: 'SET NULL' });
    Message.belongsTo(User, { as: 'sender', foreignKey: { name: 'senderId', allowNull: false }, onDelete: 'RESTRICT' });

    MessageReadBy.belongsTo(Message, { foreignKey: { name: 'messageId', allowNull: false }, onDelete: 'CASCADE' });
    MessageReadBy.belongsTo(User, { foreignKey: { name: 'userId', allowNull: false }, onDelete: 'CASCADE' });

    MessageMention.belongsTo(Message, { foreignKey: { name: 'messageId', allowNull: false }, onDelete: 'CASCADE' });
    MessageMention.belongsTo(User, { foreignKey: { name: 'userId', allowNull: false }, onDelete: 'CASCADE' });

    MessageReaction.belongsTo(Message, { foreignKey: { name: 'messageId', allowNull: false }, onDelete: 'CASCADE' });
    MessageReaction.belongsTo(User, { foreignKey: { name: 'userId', allowNull: false }, onDelete: 'CASCADE' });

    Notification.belongsTo(Company, { foreignKey: { name: 'companyId', allowNull: true }, onDelete: 'SET NULL' });
    Notification.belongsTo(User, { foreignKey: { name: 'userId', allowNull: false }, onDelete: 'CASCADE' });

    Attendance.belongsTo(Company, { foreignKey: { name: 'companyId', allowNull: true }, onDelete: 'SET NULL' });
    Attendance.belongsTo(User, { foreignKey: { name: 'userId', allowNull: false }, onDelete: 'CASCADE' });

    ProjectPersonalNote.belongsTo(Project, { foreignKey: { name: 'projectId', allowNull: false }, onDelete: 'CASCADE' });
    ProjectPersonalNote.belongsTo(User, { foreignKey: { name: 'userId', allowNull: false }, onDelete: 'CASCADE' });

    return models;
};

module.exports = {
    defineModels
};
