const dictionaries = {
    en: {
        common: {
            internal_server_error: 'Internal server error',
            active_company_required: 'Active company required',
            insufficient_permissions: 'Insufficient permissions',
            company_not_found: 'Company not found'
        },
        version: {
            version_required: 'Version is required',
            no_version_found: 'No version found'
        },
        subscription: {
            select_paid_plan: 'Please select a paid plan',
            only_card_supported: 'Only card payment is supported',
            plan_missing_integration: 'Plan is missing Paymob integration ID',
            paymob_keys_required: 'PAYMOB_SECRET_KEY and PAYMOB_PUBLIC_KEY are required',
            already_active_until: 'You already have an active {{plan}} subscription until {{expiresAt}}.',
            missing_client_secret: 'Missing client_secret from Paymob response',
            paymob_checkout_created: 'Paymob checkout created successfully',
            webhook_processed: 'Webhook processed',
            missing_company_webhook: 'Missing companyId in webhook payload',
            missing_plan_webhook: 'Missing planId and no pending plan found for company',
            no_pending_subscription: 'No pending subscription found to confirm',
            invalid_post_pay_url: 'Invalid postPayUrl',
            payment_not_successful: 'Payment is not marked as successful',
            subscription_activated: 'Subscription activated successfully',
            subscription_already_active: 'Subscription is already active',
            cancelled_successfully: 'Subscription cancelled successfully',
            missing_paymob_subscription_id: 'Missing Paymob subscription id',
            paymob_api_key_required: 'PAYMOB_API_KEY is required to manage recurring subscriptions',
            plan_missing_subscription_plan_id: 'Plan is missing Paymob subscription plan ID',
            notice_grace: 'Your subscription expired. Grace period ends in {{days}} day(s).',
            notice_downgraded: 'Your grace period ended and your subscription has been downgraded to Free.'
        },
        plans: {
            monthly: 'Monthly',
            free_name: 'Free',
            free_description: 'Default plan for new companies',
            free_feature_1: 'Up to 3 accounts',
            free_feature_2: 'Up to 3 projects',
            free_feature_3: 'No chat images, videos, or files',
            free_feature_4: 'No attendance edit or download',
            basic_name: 'Basic',
            basic_description: 'For growing teams',
            basic_feature_1: 'From 3 to 10 members',
            basic_feature_2: 'Up to 10 projects',
            basic_feature_3: 'Chat attachments enabled',
            basic_feature_4: 'Attendance edit and report download',
            pro_name: 'Pro',
            pro_description: 'For larger teams',
            pro_feature_1: 'From 10 to 30 members',
            pro_feature_2: 'Unlimited projects',
            pro_feature_3: 'Chat attachments enabled',
            pro_feature_4: 'Attendance edit and report download',
            enterprise_name: 'Enterprise',
            enterprise_description: 'For organizations with 30+ members',
            enterprise_feature_1: '30+ members',
            enterprise_feature_2: 'Unlimited projects',
            enterprise_feature_3: 'Chat attachments enabled',
            enterprise_feature_4: 'Attendance edit and report download'
        },
        notifications: {
            active_company_required: 'Active company required',
            all_marked_read: 'All notifications marked as read',
            marked_read: 'Notifications marked as read',
            ids_or_all_required: 'Provide body.ids (array of notification ids) or body.all: true',
            not_found: 'Notification not found'
        }
    },
    ar: {
        common: {
            internal_server_error: 'حدث خطأ داخلي في الخادم',
            active_company_required: 'يجب تحديد الشركة النشطة',
            insufficient_permissions: 'ليس لديك صلاحية كافية',
            company_not_found: 'الشركة غير موجودة'
        },
        version: {
            version_required: 'الإصدار مطلوب',
            no_version_found: 'لا يوجد إصدار محفوظ'
        },
        subscription: {
            select_paid_plan: 'يرجى اختيار باقة مدفوعة',
            only_card_supported: 'طريقة الدفع المتاحة حاليًا هي البطاقة فقط',
            plan_missing_integration: 'معرّف Paymob الخاص بالباقة غير متوفر',
            paymob_keys_required: 'مفاتيح Paymob غير مكتملة في إعدادات الخادم',
            already_active_until: 'لديك بالفعل باقة {{plan}} نشطة حتى {{expiresAt}}.',
            missing_client_secret: 'لم يتم استلام client_secret من Paymob',
            paymob_checkout_created: 'تم إنشاء رابط الدفع بنجاح',
            webhook_processed: 'تمت معالجة إشعار الدفع',
            missing_company_webhook: 'لم يتم العثور على معرف الشركة في webhook',
            missing_plan_webhook: 'لم يتم العثور على معرف الباقة في webhook',
            no_pending_subscription: 'لا يوجد اشتراك معلق للتأكيد',
            invalid_post_pay_url: 'رابط postPay غير صالح',
            payment_not_successful: 'عملية الدفع غير مؤكدة كنجاح',
            subscription_activated: 'تم تفعيل الاشتراك بنجاح',
            subscription_already_active: 'الاشتراك مفعل بالفعل',
            cancelled_successfully: 'تم إلغاء الاشتراك بنجاح',
            missing_paymob_subscription_id: 'معرّف اشتراك Paymob غير موجود',
            paymob_api_key_required: 'مفتاح PAYMOB_API_KEY مطلوب لإدارة الاشتراكات التلقائية',
            plan_missing_subscription_plan_id: 'معرّف خطة الاشتراك في Paymob غير متوفر لهذه الباقة',
            notice_grace: 'انتهى الاشتراك. فترة السماح تنتهي بعد {{days}} يوم.',
            notice_downgraded: 'انتهت فترة السماح وتم التحويل إلى الباقة المجانية.'
        },
        plans: {
            monthly: 'شهريًا',
            free_name: 'مجانية',
            free_description: 'الباقة الافتراضية للشركات الجديدة',
            free_feature_1: 'حتى 3 حسابات',
            free_feature_2: 'حتى 3 مشاريع',
            free_feature_3: 'بدون صور أو فيديو أو ملفات في الشات',
            free_feature_4: 'بدون تعديل أو تحميل الحضور',
            basic_name: 'أساسية',
            basic_description: 'لفِرَق العمل المتوسطة',
            basic_feature_1: 'من 3 إلى 10 أفراد',
            basic_feature_2: 'حتى 10 مشاريع',
            basic_feature_3: 'إتاحة مرفقات الشات',
            basic_feature_4: 'تعديل الحضور وتحميل التقارير',
            pro_name: 'احترافية',
            pro_description: 'لفِرَق العمل الكبيرة',
            pro_feature_1: 'من 10 إلى 30 فرد',
            pro_feature_2: 'مشاريع غير محدودة',
            pro_feature_3: 'إتاحة مرفقات الشات',
            pro_feature_4: 'تعديل الحضور وتحميل التقارير',
            enterprise_name: 'المؤسسات',
            enterprise_description: 'لمؤسسات يزيد عدد أفرادها عن 30',
            enterprise_feature_1: 'أكثر من 30 فرد',
            enterprise_feature_2: 'مشاريع غير محدودة',
            enterprise_feature_3: 'إتاحة مرفقات الشات',
            enterprise_feature_4: 'تعديل الحضور وتحميل التقارير'
        },
        notifications: {
            active_company_required: 'يجب تحديد الشركة النشطة',
            all_marked_read: 'تم تحديد كل الإشعارات كمقروءة',
            marked_read: 'تم تحديد الإشعارات كمقروءة',
            ids_or_all_required: 'يرجى إرسال body.ids (مصفوفة معرفات الإشعارات) أو body.all: true',
            not_found: 'الإشعار غير موجود'
        }
    }
};

const rawMessageTranslations = {
    ar: {
        'No images uploaded': 'لم يتم رفع أي صور',
        'Images uploaded successfully': 'تم رفع الصور بنجاح',
        'Failed to upload images': 'فشل في رفع الصور',
        'Image deleted successfully': 'تم حذف الصورة بنجاح',
        'Image not found': 'الصورة غير موجودة',
        'Failed to delete image': 'فشل في حذف الصورة',
        'You are not a member of this company': 'أنت لست عضوًا في هذه الشركة',
        'Access token required': 'رمز الدخول مطلوب',
        'Invalid token': 'رمز الدخول غير صالح',
        'Invalid or expired token': 'رمز الدخول غير صالح أو منتهي',
        'Authentication required': 'تسجيل الدخول مطلوب',
        'Question sent successfully to brofa@absai.dev': 'تم إرسال السؤال بنجاح إلى brofa@absai.dev',
        'Failed to send question': 'فشل في إرسال السؤال',
        'All notifications marked as read': 'تم تحديد كل الإشعارات كمقروءة',
        'Notifications marked as read': 'تم تحديد الإشعارات كمقروءة',
        'Provide body.ids (array of notification ids) or body.all: true': 'يرجى إرسال body.ids (مصفوفة معرفات الإشعارات) أو body.all: true',
        'Notification not found': 'الإشعار غير موجود',
        'Project created successfully': 'تم إنشاء المشروع بنجاح',
        'Assigned users array is required': 'مصفوفة المستخدمين المعيّنين مطلوبة',
        'Project not found': 'المشروع غير موجود',
        'You can only manage projects in your active company': 'يمكنك إدارة مشاريع شركتك النشطة فقط',
        'Assigned users must belong to the active company': 'يجب أن يكون المستخدمون المعيّنون ضمن الشركة النشطة',
        'Some assigned users are invalid': 'بعض المستخدمين المعيّنين غير صالحين',
        'Users assigned to project successfully': 'تم تعيين المستخدمين للمشروع بنجاح',
        'Access denied to this project': 'ليس لديك صلاحية للوصول لهذا المشروع',
        'Status is required': 'الحالة مطلوبة',
        'You can only update projects in your active company': 'يمكنك تحديث مشاريع شركتك النشطة فقط',
        'Project status updated successfully': 'تم تحديث حالة المشروع بنجاح',
        'Company not found': 'الشركة غير موجودة',
        'User not found': 'المستخدم غير موجود',
        'Current password and new password are required': 'كلمة المرور الحالية والجديدة مطلوبتان',
        'Current password is incorrect': 'كلمة المرور الحالية غير صحيحة',
        'Password changed successfully': 'تم تغيير كلمة المرور بنجاح',
        'Valid FCM token is required': 'رمز FCM صالح مطلوب',
        'FCM token registered successfully': 'تم تسجيل رمز FCM بنجاح',
        'FCM token unregistered successfully': 'تم إلغاء تسجيل رمز FCM بنجاح',
        'token and password are required': 'الرمز وكلمة المرور مطلوبان',
        'Password must be at least 6 characters': 'يجب أن تكون كلمة المرور 6 أحرف على الأقل',
        'Invalid invitation token': 'رمز الدعوة غير صالح',
        'Invitation token expired': 'رمز الدعوة منتهي الصلاحية',
        'Invitation accepted successfully. You can now login.': 'تم قبول الدعوة بنجاح. يمكنك تسجيل الدخول الآن.',
        'Profile updated successfully': 'تم تحديث الملف الشخصي بنجاح',
        'Check-in successful': 'تم تسجيل الحضور بنجاح',
        'Check-out successful': 'تم تسجيل الانصراف بنجاح',
        'No open check-in found.': 'لا يوجد حضور مفتوح',
        'Attendance record not found': 'سجل الحضور غير موجود',
        'Invalid checkIn date': 'تاريخ checkIn غير صالح',
        'Invalid checkOut date': 'تاريخ checkOut غير صالح',
        'Invalid status': 'الحالة غير صالحة',
        'checkOut must be after checkIn': 'يجب أن يكون checkOut بعد checkIn',
        'Attendance updated successfully': 'تم تحديث الحضور بنجاح',
        'Send both month (1–12) and year together, or omit both.': 'أرسل الشهر (1-12) والسنة معًا، أو احذفهما معًا',
        'Month (1–12) and year are required.': 'الشهر (1-12) والسنة مطلوبان',
        'Invalid format. Use xlsx or csv.': 'صيغة غير صالحة. استخدم xlsx أو csv',
        'Server is running': 'الخادم يعمل',
        'ABSAI Ticket Management API is running!': 'واجهة ABSAI Ticket Management API تعمل',
        'Internal server error': 'حدث خطأ داخلي في الخادم',
        'Active company required': 'يجب تحديد الشركة النشطة',
        'Insufficient permissions': 'ليس لديك صلاحية كافية',
        'No version found': 'لا يوجد إصدار محفوظ',
        'Version is required': 'الإصدار مطلوب'
        ,
        'Invalid credentials': 'بيانات تسجيل الدخول غير صحيحة',
        'Invalid credentials for existing user. Use your current account password to add another company.': 'بيانات المستخدم الحالي غير صحيحة. استخدم كلمة المرور الحالية لإضافة شركة جديدة.',
        'This account cannot login with password': 'هذا الحساب لا يمكنه تسجيل الدخول بكلمة مرور',
        'Email and password are required': 'البريد الإلكتروني وكلمة المرور مطلوبان',
        'Login successful': 'تم تسجيل الدخول بنجاح',
        'companyId is required: you belong to more than one company': 'معرّف الشركة مطلوب لأنك عضو في أكثر من شركة',
        'You are not a member of the selected company': 'أنت لست عضوًا في الشركة المحددة',
        'companyId is required': 'معرّف الشركة مطلوب',
        'Company context updated': 'تم تحديث سياق الشركة',
        'Email is required': 'البريد الإلكتروني مطلوب',
        'OTP sent to your email': 'تم إرسال رمز التحقق إلى بريدك الإلكتروني',
        'Email, OTP, and new password are required': 'البريد الإلكتروني ورمز التحقق وكلمة المرور الجديدة مطلوبة',
        'OTP not found or expired': 'رمز التحقق غير موجود أو منتهي الصلاحية',
        'OTP expired': 'رمز التحقق منتهي الصلاحية',
        'Invalid OTP': 'رمز التحقق غير صحيح',
        'Password reset successfully': 'تم إعادة تعيين كلمة المرور بنجاح',
        'companyName, email and password are required': 'اسم الشركة والبريد الإلكتروني وكلمة المرور مطلوبة',
        'Existing account has no password. Please reset password first, then create company.': 'الحساب الحالي لا يحتوي على كلمة مرور. أعد تعيين كلمة المرور أولاً ثم أنشئ الشركة.',
        'Company registered successfully': 'تم تسجيل الشركة بنجاح'
    }
};

const normalizeLang = (value) => {
    const raw = String(value || 'en').toLowerCase();
    if (raw.startsWith('ar')) return 'ar';
    return 'en';
};

const interpolate = (template, vars = {}) => {
    let result = template;
    Object.entries(vars).forEach(([key, value]) => {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
    });
    return result;
};

const t = (lang, key, vars = {}) => {
    const normalized = normalizeLang(lang);
    const [scope, name] = key.split('.');
    const enValue = dictionaries.en?.[scope]?.[name];
    const targetValue = dictionaries[normalized]?.[scope]?.[name] || enValue;
    if (!targetValue) return key;
    return interpolate(targetValue, vars);
};

const localizePlan = (plan, lang) => {
    const normalized = normalizeLang(lang);
    const id = plan.id;
    const localizedName = dictionaries[normalized]?.plans?.[`${id}_name`] || plan.name;
    const localizedDescription = dictionaries[normalized]?.plans?.[`${id}_description`] || plan.description;
    const localizedFeatures = (plan.features || []).map((feature, index) =>
        dictionaries[normalized]?.plans?.[`${id}_feature_${index + 1}`] || feature
    );

    return {
        ...plan,
        name: localizedName,
        description: localizedDescription,
        features: localizedFeatures,
        billingPeriod: dictionaries[normalized]?.plans?.[String(plan.billingPeriod || '').toLowerCase()] || plan.billingPeriod
    };
};

const localizeNotification = (notification, lang) => {
    if (!notification || typeof notification !== 'object') return notification;
    return {
        ...notification,
        title: translateRawMessage(lang, notification.title),
        message: translateRawMessage(lang, notification.message),
        body: translateRawMessage(lang, notification.body)
    };
};

const translateRawMessage = (lang, message) => {
    const normalized = normalizeLang(lang);
    if (normalized === 'en') return message;
    const text = String(message || '');
    const mapped = rawMessageTranslations[normalized]?.[text];
    if (mapped) return mapped;

    if (text.startsWith('Missing required fields: ')) {
        const fields = text.replace('Missing required fields: ', '');
        return `الحقول المطلوبة غير مكتملة: ${fields}`;
    }
    if (text.startsWith('Invalid role. Allowed roles: ')) {
        const roles = text.replace('Invalid role. Allowed roles: ', '');
        return `الدور غير صالح. الأدوار المسموح بها: ${roles}`;
    }
    if (text.startsWith('Current ') && text.includes(' plan allows up to ')) {
        return text
            .replace('Current ', 'الخطة الحالية ')
            .replace(' plan allows up to ', ' تسمح حتى ')
            .replace(' accounts.', ' حسابات.');
    }
    if (text === 'Active company required. Log in with a company or switch company first.') {
        return 'يجب تحديد الشركة النشطة. سجل الدخول بشركة أو غيّر الشركة أولاً';
    }
    if (text === 'Active company required. Log in with a company, register a company, or call POST /api/auth/switch-company.') {
        return 'يجب تحديد الشركة النشطة. سجل الدخول بشركة أو أنشئ شركة أو استخدم POST /api/auth/switch-company';
    }
    return message;
};

module.exports = {
    t,
    normalizeLang,
    localizePlan,
    localizeNotification,
    translateRawMessage
};
